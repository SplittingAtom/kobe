import type { ServerToSandboxFrame, SkillDraftSaveFrame } from "@kobe/protocol";
import type { Logger } from "pino";
import type { AllowedVerdict } from "../artifacts/allowed.js";
import type { SkillDraftRefusal, SkillDraftToolResult } from "../skills/drafts/tool.js";
import type { WireContext } from "./context.js";
import type { SandboxTarget } from "./types.js";

/**
 * `skill.draft_save` (KOBE-442) on one connection: accepted only if it announced `skill_drafts`,
 * the run is leased here and active, and this `save_skill_draft` call was allowed here with the
 * same canonical input hash (D-3), taken once: a replay of the call is refused (review M1). The save itself is `ctx.skillDrafts`. Every
 * refusal is audited (no names, paths or content) and answered with `skill.draft_save_result`.
 */
export interface SkillDraftSaveConnection {
  readonly ctx: WireContext;
  readonly target: SandboxTarget;
  readonly sandboxId: string;
  readonly log: Pick<Logger, "error">;
  readonly hasCapability: boolean;
  /** `#checkToolRun` for this frame; "violation" was already answered and the frame dropped. */
  readonly runCheck: () => "ok" | "ended" | "violation";
  /** Takes the allowance (single use): a second frame for the call is "replayed". */
  readonly verdict: () => AllowedVerdict | "replayed";
  /** Saves in flight on this connection, and the cap. */
  readonly inFlight: { count: number };
  send(frame: ServerToSandboxFrame): boolean;
}

export function onSkillDraftSave(c: SkillDraftSaveConnection, frame: SkillDraftSaveFrame): void {
  const fail = (code: string, message: string) =>
    c.send({
      v: 1,
      type: "skill.draft_save_result",
      request_id: frame.request_id,
      ok: false,
      error: { code, message },
    });
  const audit = (reason: SkillDraftRefusal) =>
    c.ctx.auditSkillDraftRefused(c.target, c.sandboxId, {
      reason,
      runId: frame.run_id,
      toolCallId: frame.tool_call_id,
    });
  const refuse = (reason: SkillDraftRefusal, message: string) => {
    audit(reason);
    fail("not_allowed", message);
  };
  if (!c.hasCapability) {
    refuse("capability_missing", "This sandbox did not announce skill drafts.");
    return;
  }
  const check = c.runCheck();
  if (check === "violation") return;
  if (check === "ended") {
    refuse("run_not_active", "The run has ended, so the skill was not saved.");
    return;
  }
  const verdict = c.verdict();
  if (verdict !== "ok") {
    refuse(
      verdict,
      verdict === "input_mismatch"
        ? "The folder differs from the call that was allowed."
        : verdict === "replayed"
          ? "This tool call was already used to save a skill."
          : "This tool call was not allowed for this tool.",
    );
    return;
  }
  const tool = c.ctx.skillDrafts;
  if (!tool) {
    fail("storage_failed", "Skill drafts are not available here.");
    return;
  }
  if (c.inFlight.count >= c.ctx.tuning.maxPendingArtifactPuts) {
    fail("storage_failed", "Too many skills are being saved. Try again.");
    return;
  }
  c.inFlight.count += 1;
  void tool
    .save(c.target, frame)
    .catch((err: unknown): SkillDraftToolResult => {
      c.log.error({ err }, "skill.draft_save failed");
      return {
        ok: false,
        code: "storage_failed",
        message: "The skill could not be saved. Try again.",
      };
    })
    .then((result) => {
      c.inFlight.count -= 1;
      if (result.ok) {
        c.send({
          v: 1,
          type: "skill.draft_save_result",
          request_id: frame.request_id,
          ok: true,
          op: "skill_draft_save",
          draft_id: result.draftId,
          name: result.name,
          created: result.created,
          rev: result.rev,
          file_count: result.fileCount,
          ...(result.newBecause ? { new_because: result.newBecause } : {}),
        });
        return;
      }
      if (result.refusal) audit(result.refusal);
      fail(result.code, result.message);
    });
}

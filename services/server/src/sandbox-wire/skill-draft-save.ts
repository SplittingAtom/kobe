import {
  CAPABILITY_SKILL_DRAFTS,
  type ServerToSandboxFrame,
  type SkillDraftSaveFrame,
} from "@kobe/protocol";
import type { Logger } from "pino";
import type { SkillDraftRefusal, SkillDraftToolResult } from "../skills/drafts/tool.js";
import type { WireContext } from "./context.js";
import type { InFlight, ToolFrameSpec } from "./gated-frame.js";
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
  /** Saves in flight on this connection (capped at `maxPendingArtifactPuts` by the gate). */
  readonly inFlight: InFlight;
  send(frame: ServerToSandboxFrame): boolean;
}

/** The gate's spec for `skill.draft_save`: single use (review M1), one allowed call is one save. */
export function skillDraftSaveSpec(
  c: SkillDraftSaveConnection,
): ToolFrameSpec<SkillDraftSaveFrame, "consume"> {
  const fail = (frame: SkillDraftSaveFrame, code: string, message: string) =>
    c.send({
      v: 1,
      type: "skill.draft_save_result",
      request_id: frame.request_id,
      ok: false,
      error: { code, message },
    });
  const audit = (frame: SkillDraftSaveFrame, reason: SkillDraftRefusal) =>
    c.ctx.auditSkillDraftRefused(c.target, c.sandboxId, {
      reason,
      runId: frame.run_id,
      toolCallId: frame.tool_call_id,
    });
  const refuse = (frame: SkillDraftSaveFrame, reason: SkillDraftRefusal, message: string) => {
    audit(frame, reason);
    fail(frame, "not_allowed", message);
  };
  return {
    capabilities: [CAPABILITY_SKILL_DRAFTS],
    allowance: "consume",
    inFlight: c.inFlight,
    refuse(frame, refusal) {
      switch (refusal.stage) {
        case "capability":
          refuse(frame, "capability_missing", "This sandbox did not announce skill drafts.");
          return;
        case "ended":
          refuse(frame, "run_not_active", "The run has ended, so the skill was not saved.");
          return;
        case "verdict": {
          const { verdict } = refusal;
          refuse(
            frame,
            verdict,
            verdict === "input_mismatch"
              ? "The folder differs from the call that was allowed."
              : verdict === "replayed"
                ? "This tool call was already used to save a skill."
                : "This tool call was not allowed for this tool.",
          );
          return;
        }
        case "busy":
          fail(frame, "storage_failed", "Too many skills are being saved. Try again.");
          return;
      }
    },
    afterAllowance(frame) {
      if (c.ctx.skillDrafts) return false;
      fail(frame, "storage_failed", "Skill drafts are not available here.");
      return true;
    },
    act(frame) {
      const tool = c.ctx.skillDrafts;
      if (!tool) return; // checked after the allowance
      return tool
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
          if (result.refusal) audit(frame, result.refusal);
          fail(frame, result.code, result.message);
        });
    },
  };
}

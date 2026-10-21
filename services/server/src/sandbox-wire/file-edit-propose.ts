import { sql, type KobeDb } from "@kobe/db";
import {
  EVENT_PAYLOAD_MAX_BYTES,
  jsonByteLength,
  workspaceToolPath,
  type FileEditProposeFrame,
  type FileEditProposedPayload,
  type ServerToSandboxFrame,
} from "@kobe/protocol";
import type { Logger } from "pino";
import type { AllowedVerdict } from "../artifacts/allowed.js";
import { appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import { isInternalPath, isReadOnlyPath } from "../workspace-files/paths.js";
import { currentEntry } from "../workspace-sync/store.js";
import type { SandboxTarget } from "./types.js";

/**
 * `file.edit_propose` (KOBE-462, file-editor.ts; spec FE8) on one connection: accepted only if it
 * announced `file_edits`, the run is leased here and active, and this `propose_file_edit` call
 * was allowed here with the same canonical input hash, taken once. Writes no file: the proposal is
 * recorded as the run's `file.edit_proposed` event (the web's only source for the diff), based on
 * the synced copy's current version, and answered `awaiting_user`.
 */
export interface FileEditProposeConnection {
  readonly db: KobeDb;
  readonly target: SandboxTarget;
  readonly runMaxEvents: number;
  readonly log: Pick<Logger, "error" | "warn">;
  readonly hasCapability: boolean;
  /** `#checkToolRun` for this frame; "violation" was already answered and the frame dropped. */
  readonly runCheck: () => "ok" | "ended" | "violation";
  /** Takes the allowance (single use): a second frame for the call is "replayed". */
  readonly verdict: () => AllowedVerdict | "replayed";
  send(frame: ServerToSandboxFrame): boolean;
}

export type ProposeOutcome =
  | { readonly ok: true; readonly path: string; readonly baseSha256: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

const refused = (code: string, message: string): ProposeOutcome => ({ ok: false, code, message });

export function onFileEditPropose(c: FileEditProposeConnection, frame: FileEditProposeFrame): void {
  const answer = (outcome: ProposeOutcome) =>
    c.send(
      outcome.ok
        ? {
            v: 1,
            type: "file.edit_propose_result",
            request_id: frame.request_id,
            ok: true,
            op: "file_edit_propose",
            status: "awaiting_user",
            path: outcome.path,
            base_sha256: outcome.baseSha256,
          }
        : {
            v: 1,
            type: "file.edit_propose_result",
            request_id: frame.request_id,
            ok: false,
            error: { code: outcome.code, message: outcome.message },
          },
    );
  if (!c.hasCapability) {
    answer(refused("not_allowed", "This sandbox did not announce file edits."));
    return;
  }
  // A skill eval's sandbox (KOBE-325) never reaches the member's workspace (also denied by policy).
  if (c.target.evalThreadId !== undefined) {
    answer(refused("not_allowed", "Skill evals never propose edits to the member's files."));
    return;
  }
  const check = c.runCheck();
  if (check === "violation") return;
  if (check === "ended") {
    answer(refused("not_allowed", "The run has ended, so the edit was not proposed."));
    return;
  }
  const verdict = c.verdict();
  if (verdict !== "ok") {
    c.log.warn({ run_id: frame.run_id, verdict, security: true }, "file.edit_propose refused");
    answer(
      refused(
        "not_allowed",
        verdict === "input_mismatch"
          ? "The edit differs from the call that was allowed."
          : verdict === "replayed"
            ? "This tool call was already used to propose an edit."
            : "This tool call was not allowed for this tool.",
      ),
    );
    return;
  }
  void proposeFileEdit(c.db, c.target, frame, c.runMaxEvents)
    .catch((err: unknown): ProposeOutcome => {
      c.log.error({ err, run_id: frame.run_id }, "file.edit_propose failed");
      return refused("storage_failed", "The proposal could not be recorded. Try again.");
    })
    .then(answer);
}

/**
 * Checks the path against the run owner's synced workspace and records the proposal. Nothing is
 * pushed or written: the base is what the member's editor would load now.
 */
export async function proposeFileEdit(
  db: KobeDb,
  target: SandboxTarget,
  frame: FileEditProposeFrame,
  runMaxEvents: number,
): Promise<ProposeOutcome> {
  const path = workspaceToolPath(frame.input.path);
  if (path === undefined) {
    return refused("invalid_path", "Name a file under /workspace.");
  }
  if (isInternalPath(path)) return refused("not_found", "There is no such file in the workspace.");
  if (isReadOnlyPath(path)) {
    return refused(
      "read_only",
      "Project files and thread uploads are read-only; propose a copy elsewhere instead.",
    );
  }
  return withAppendTx(db, target.teamId, async (tx): Promise<ProposeOutcome> => {
    const owner = { teamId: target.teamId, userId: target.userId };
    const entry = await currentEntry(tx, owner, path);
    if (!entry || entry.deleted || entry.sha256 === undefined) {
      return refused(
        "not_found",
        "That file is not in the synced workspace yet; save it first, then propose the edit.",
      );
    }
    const payload: FileEditProposedPayload = {
      tool_call_id: frame.tool_call_id,
      path,
      base_sha256: entry.sha256,
      content: frame.input.content,
      summary: frame.input.summary,
    };
    if (jsonByteLength(payload) > EVENT_PAYLOAD_MAX_BYTES) {
      return refused("too_large", "The proposed content is too large to review.");
    }
    const run = await tx.execute<{ last_seq: number }>(sql`
      SELECT last_seq FROM runs WHERE team_id = ${target.teamId} AND id = ${frame.run_id}`);
    if ((run.rows[0]?.last_seq ?? runMaxEvents) + 2 > runMaxEvents) {
      return refused("storage_failed", "This run has recorded too much to take a proposal.");
    }
    await appendRunEventsInTx(tx, target.teamId, frame.run_id, [
      { type: "file.edit_proposed", payload },
    ]);
    return { ok: true, path, baseSha256: entry.sha256 };
  });
}

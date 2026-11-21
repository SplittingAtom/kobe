import { sql, type KobeDb } from "@kobe/db";
import {
  CAPABILITY_FILE_EDITS,
  workspaceToolPath,
  type FileOpenFrame,
  type FileOpenedPayload,
  type ServerToSandboxFrame,
} from "@kobe/protocol";
import type { Logger } from "pino";
import { appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import { isInternalPath } from "../workspace-files/paths.js";
import { currentEntry } from "../workspace-sync/store.js";
import type { ToolFrameSpec } from "./gated-frame.js";
import type { SandboxTarget } from "./types.js";

/**
 * `file.open` (KOBE-484, file-open.ts) on one connection: accepted only if it announced
 * `file_edits`, the run is leased here and active, and this `open_file` call was allowed here with
 * the same canonical input hash, taken once. Reads and writes no file: the path must be a live
 * synced file of the run owner's own workspace (the agent pushed it first), and the run records
 * `file.opened {tool_call_id, path}`, on which the owner's client opens the file's tab.
 */
export interface FileOpenConnection {
  readonly db: KobeDb;
  readonly target: SandboxTarget;
  readonly runMaxEvents: number;
  readonly log: Pick<Logger, "error" | "warn">;
  send(frame: ServerToSandboxFrame): boolean;
}

export type OpenOutcome =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

const refused = (code: string, message: string): OpenOutcome => ({ ok: false, code, message });
const NOT_FOUND = refused("not_found", "There is no such file in the workspace.");

/** The gate's spec for `file.open` (rides `file_edits`): the allowance is taken once. */
export function fileOpenSpec(c: FileOpenConnection): ToolFrameSpec<FileOpenFrame, "consume"> {
  const answerer = (frame: FileOpenFrame) => (outcome: OpenOutcome) =>
    c.send(
      outcome.ok
        ? {
            v: 1,
            type: "file.open_result",
            request_id: frame.request_id,
            ok: true,
            op: "file_open",
            path: outcome.path,
          }
        : {
            v: 1,
            type: "file.open_result",
            request_id: frame.request_id,
            ok: false,
            error: { code: outcome.code, message: outcome.message },
          },
    );
  return {
    capabilities: [CAPABILITY_FILE_EDITS],
    allowance: "consume",
    // A skill eval's sandbox (KOBE-325) never reaches the member's workspace (also denied by policy).
    beforeRun(frame) {
      if (c.target.evalThreadId === undefined) return false;
      answerer(frame)(refused("not_allowed", "Skill evals never open the member's files."));
      return true;
    },
    refuse(frame, refusal) {
      const answer = answerer(frame);
      switch (refusal.stage) {
        case "capability":
          answer(refused("not_allowed", "This sandbox did not announce file edits."));
          return;
        case "ended":
          answer(refused("not_allowed", "The run has ended, so the file was not opened."));
          return;
        case "verdict": {
          const { verdict } = refusal;
          c.log.warn({ run_id: frame.run_id, verdict, security: true }, "file.open refused");
          answer(
            refused(
              "not_allowed",
              verdict === "input_mismatch"
                ? "The file differs from the call that was allowed."
                : verdict === "replayed"
                  ? "This tool call was already used to open a file."
                  : "This tool call was not allowed for this tool.",
            ),
          );
          return;
        }
        case "busy":
          return; // no in-flight cap for this kind
      }
    },
    act(frame) {
      void openFile(c.db, c.target, frame, c.runMaxEvents)
        .catch((err: unknown): OpenOutcome => {
          c.log.error({ err, run_id: frame.run_id }, "file.open failed");
          return refused("storage_failed", "The file could not be opened. Try again.");
        })
        .then(answerer(frame));
    },
  };
}

/** Checks the path against the run owner's synced workspace and records `file.opened`. */
export async function openFile(
  db: KobeDb,
  target: SandboxTarget,
  frame: FileOpenFrame,
  runMaxEvents: number,
): Promise<OpenOutcome> {
  const path = workspaceToolPath(frame.input.path);
  if (path === undefined) return refused("invalid_path", "Name a file under /workspace.");
  if (isInternalPath(path)) return NOT_FOUND;
  return withAppendTx(db, target.teamId, async (tx): Promise<OpenOutcome> => {
    const owner = { teamId: target.teamId, userId: target.userId };
    const entry = await currentEntry(tx, owner, path);
    if (!entry || entry.deleted) return NOT_FOUND;
    const run = await tx.execute<{ last_seq: number }>(sql`
      SELECT last_seq FROM runs WHERE team_id = ${target.teamId} AND id = ${frame.run_id}`);
    if ((run.rows[0]?.last_seq ?? runMaxEvents) + 2 > runMaxEvents) {
      return refused("storage_failed", "This run has recorded too much to open a file.");
    }
    const payload: FileOpenedPayload = { tool_call_id: frame.tool_call_id, path };
    await appendRunEventsInTx(tx, target.teamId, frame.run_id, [{ type: "file.opened", payload }]);
    return { ok: true, path };
  });
}

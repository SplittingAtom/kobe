import type { CommandResultFrame, ErrorInfo, SandboxToServerFrame } from "@kobe/protocol";
import type { LeaseViolation } from "../context.js";
import type { CommandDelivery } from "../delivery.js";
import type { NotebookIntake } from "../notebook-intake.js";
import type { CommandOutcome } from "../types.js";

/** What the answers to delivered commands need from their connection (KOBE-706). */
export interface CommandResultPort {
  readonly delivery: Pick<CommandDelivery, "takeIssued" | "settle">;
  readonly notebookOutputs: Pick<NotebookIntake, "drain">;
  violate(violation: LeaseViolation, frameType: string): void;
}

type CompactResultFrame = Extract<SandboxToServerFrame, { type: "thread.compact_result" }>;
type BranchSummaryResultFrame = Extract<
  SandboxToServerFrame,
  { type: "thread.branch_summary_result" }
>;

/** `command.result`: exactly one per command this connection delivered; anything else violates. */
export function onCommandResult(c: CommandResultPort, frame: CommandResultFrame): void {
  const issued = c.delivery.takeIssued(frame.command_id);
  if (issued === "answered") return;
  if (issued === undefined) {
    c.violate("unknown_command", "command.result");
    return;
  }
  const outcome: CommandOutcome = frame.ok
    ? frame.data === undefined
      ? { ok: true }
      : { ok: true, data: frame.data }
    : { ok: false, error: frame.error };
  if (issued.notebook !== undefined) {
    // NB14: the outputs this execution sent are stored before its answer is recorded.
    void c.notebookOutputs
      .drain(frame.command_id)
      .finally(() => c.delivery.settle(issued, outcome));
    return;
  }
  c.delivery.settle(issued, outcome);
}

/**
 * The one answer to a row command of `commandKind` this connection delivered, for the same thread.
 * Anything else (an unknown or duplicate command id, another command's id, another thread) is a
 * lease violation; a mismatched answer still settles its command, as failed, so nobody waits.
 */
function onRowResult(
  c: CommandResultPort,
  frame: CompactResultFrame | BranchSummaryResultFrame,
  commandKind: "thread.compact" | "thread.branch_summary",
  mismatch: string,
): void {
  const issued = c.delivery.takeIssued(frame.command_id);
  if (issued === "answered") return;
  const matches =
    issued !== undefined &&
    issued.kind === "row" &&
    issued.commandKind === commandKind &&
    issued.threadId === frame.thread_id;
  if (!matches) {
    if (issued !== undefined) {
      c.delivery.settle(issued, {
        ok: false,
        error: { code: "malformed_result", message: mismatch },
      });
    }
    c.violate("unknown_run", frame.type);
    return;
  }
  const { v: _v, type: _t, command_id: _c, thread_id: _th, ok, ...rest } = frame;
  c.delivery.settle(
    issued,
    ok ? { ok: true, data: rest } : { ok: false, error: (rest as { error: ErrorInfo }).error },
  );
}

/** The one answer to a `thread.compact` this connection delivered (KOBE-213). */
export function onCompactResult(c: CommandResultPort, frame: CompactResultFrame): void {
  onRowResult(c, frame, "thread.compact", "a compaction result for another command");
}

/** The one answer to a `thread.branch_summary` (KOBE-548): checked as a compaction result. */
export function onBranchSummaryResult(c: CommandResultPort, frame: BranchSummaryResultFrame): void {
  onRowResult(c, frame, "thread.branch_summary", "a branch summary result for another command");
}

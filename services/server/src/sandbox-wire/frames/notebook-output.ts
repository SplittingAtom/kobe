import type { NotebookOutputFrame } from "@kobe/protocol";
import type { LeaseViolation, WireMetrics } from "../context.js";
import type { CommandDelivery } from "../delivery.js";
import type { NotebookIntake } from "../notebook-intake.js";

/** What a `notebook.output` needs from its connection (KOBE-706: moved out of connection.ts). */
export interface NotebookOutputPort {
  readonly delivery: Pick<CommandDelivery, "peekIssued">;
  readonly intake: Pick<NotebookIntake, "accept">;
  readonly metrics: WireMetrics;
  violate(violation: LeaseViolation, frameType: string): void;
}

/**
 * `notebook.output` (KOBE-464, NB14): only for a `notebook.execute` this connection delivered and
 * has not had answered, for the same thread; the run and exec ids come from that command. Late
 * outputs of an answered command are dropped; anything else is a lease violation.
 */
export function onNotebookOutput(
  c: NotebookOutputPort,
  frame: NotebookOutputFrame,
  bytes: number,
): void {
  const issued = c.delivery.peekIssued(frame.command_id);
  if (issued === "answered") {
    c.metrics.notebookOutputsDropped += 1;
    return;
  }
  const exec = issued?.notebook;
  if (exec === undefined || exec.threadId !== frame.thread_id) {
    c.violate("unknown_command", "notebook.output");
    return;
  }
  c.intake.accept(frame.command_id, exec, frame, bytes);
}

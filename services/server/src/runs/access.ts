import type { KobeTx } from "@kobe/db";
import { findThread, type Viewer } from "../threads/repository.js";
import { RunError } from "./errors.js";
import { getRunRow, lockRunRow, lockThreadRow, type RunRow, type ThreadRow } from "./store.js";

/**
 * Locks a thread the actor owns (KOBE-34 visibility: readers of a shared thread get `read_only`,
 * everyone else the same 404) and refuses Trash. The thread row is the first lock taken.
 */
export async function lockOwnedThread(
  tx: KobeTx,
  viewer: Viewer,
  threadId: string,
  notFound: "thread_not_found" | "run_not_found",
): Promise<ThreadRow> {
  const found = await findThread(tx, viewer, threadId, { lock: true });
  if (!found) throw new RunError(notFound);
  if (found.access !== "owner") throw new RunError("read_only");
  const thread = await lockThreadRow(tx, viewer.teamId, threadId);
  if (!thread) throw new RunError(notFound);
  if (thread.deletedAt !== null) throw new RunError("thread_in_trash");
  return thread;
}

/** The run and its thread for a change by the thread's owner (thread locked, then the run). */
export async function ownedRun(
  tx: KobeTx,
  viewer: Viewer,
  runId: string,
  lock: boolean,
): Promise<{ thread: ThreadRow; run: RunRow }> {
  const head = await getRunRow(tx, viewer.teamId, runId);
  if (!head) throw new RunError("run_not_found");
  if (!lock) {
    const found = await findThread(tx, viewer, head.threadId);
    if (!found) throw new RunError("run_not_found");
    if (found.access !== "owner") throw new RunError("read_only");
    return { thread: found.thread, run: head };
  }
  const thread = await lockOwnedThread(tx, viewer, head.threadId, "run_not_found");
  const run = await lockRunRow(tx, viewer.teamId, runId);
  if (!run) throw new RunError("run_not_found");
  return { thread, run };
}

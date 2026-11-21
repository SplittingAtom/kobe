import type { Logger } from "pino";
import { withAppendTx } from "../../event-stream/append.js";
import type { WireContext } from "../context.js";
import { endRunInTx, type InterruptCause } from "../run-state.js";
import type { SandboxTarget } from "../types.js";

/** Ending a run from the wire (KOBE-706: moved out of connection.ts). Both never throw. */

/** A storage cap: the run fails with a terminal event within the cap. */
export async function failOversizedRun(
  ctx: WireContext,
  target: SandboxTarget,
  runId: string,
  threadId: string,
  limit: "run_events" | "run_bytes" | "thread_entries",
  log: Pick<Logger, "error">,
): Promise<void> {
  const code = limit === "thread_entries" ? "thread_too_large" : "run_too_large";
  try {
    const { ended } = await withAppendTx(ctx.db, target.teamId, (tx) =>
      endRunInTx(tx, target.teamId, runId, {
        status: "failed",
        error: { code, message: "The run produced more output than Kobe stores for one run." },
      }),
    );
    if (ended) ctx.runEnded({ teamId: target.teamId, runId, threadId, status: "failed" });
  } catch (err) {
    log.error({ err, run_id: runId }, "could not fail an oversized run");
  }
}

/** Interrupts an active run (D14: never retried automatically). */
export async function interruptRun(
  ctx: WireContext,
  target: SandboxTarget,
  runId: string,
  cause: InterruptCause,
  log: Pick<Logger, "error">,
): Promise<void> {
  try {
    const { ended, threadId } = await withAppendTx(ctx.db, target.teamId, (tx) =>
      endRunInTx(tx, target.teamId, runId, { status: "interrupted" }, cause),
    );
    if (ended && threadId) {
      ctx.metrics.runsInterrupted += 1;
      ctx.runEnded({ teamId: target.teamId, runId, threadId, status: "interrupted" });
    }
  } catch (err) {
    log.error({ err, run_id: runId }, "could not interrupt run");
  }
}

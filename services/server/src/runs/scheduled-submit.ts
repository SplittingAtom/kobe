import type { KobeTx } from "@kobe/db";

/**
 * Work the scheduler (KOBE-174) does inside the submit transaction, so that the schedule's claim,
 * the `schedule.fire` event, the thread and the run commit together or not at all: a replica that
 * dies mid-way leaves nothing behind, and the row lock it held is released with its connection.
 */
export interface ScheduledSubmit {
  /**
   * First step of the transaction, before the thread is looked up. Creates the thread the command
   * names. Throwing aborts the whole submit (nothing is kept).
   */
  before(tx: KobeTx): Promise<void>;
  /**
   * Last step of the transaction. `budgetBlocked`: the budget gate refused the run, so it was
   * recorded as failed (visible in the thread) instead of queued, without a retry.
   */
  after(
    tx: KobeTx,
    outcome: { readonly runId: string; readonly budgetBlocked: boolean },
  ): Promise<void>;
}

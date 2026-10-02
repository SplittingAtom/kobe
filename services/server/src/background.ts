import { logger } from "./logger.js";

/**
 * Work kept off the request path on purpose (reset and invitation emails, audit of anonymous
 * attempts), so a response and its timing don't depend on it. A task's failure is logged, never
 * thrown. `idle()` resolves once nothing is in flight: shutdown drains with it before closing the
 * database, and tests wait on the work itself instead of guessing a delay.
 */
export class BackgroundTasks {
  private readonly pending = new Set<Promise<void>>();

  /** Starts `task` now; on failure logs `failure` with `context`. */
  run(failure: string, task: () => Promise<unknown>, context: Record<string, unknown> = {}): void {
    const tracked = (async () => {
      try {
        await task();
      } catch (err) {
        logger.error({ err, ...context }, failure);
      }
    })().finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /** Resolves once every task, including ones started by tasks while waiting, has settled. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}

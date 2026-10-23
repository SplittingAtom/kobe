/**
 * Runs that ended without a live lease on this connection (KOBE-483): a reconnect's hello found
 * them leased to this sandbox but no longer offered, so they were interrupted. The agent may still
 * have a frame for such a run on its way (Pi emits a status update while it aborts, a paced queue
 * drains late). Within a short grace window such a frame is dropped, never processed, and the
 * connection stays; afterwards, or for any other run or thread, it is a lease violation as before.
 * Memory is bounded by count and time.
 */
export const LATE_FRAME_GRACE_MS = 30_000;
export const RECENTLY_ENDED_MAX = 256;

export type RecentMatch = "match" | "thread_mismatch" | "none";

export class RecentlyEndedRuns {
  readonly #graceMs: number;
  readonly #max: number;
  readonly #now: () => number;
  readonly #runs = new Map<string, { threadId: string; at: number }>();

  constructor(graceMs = LATE_FRAME_GRACE_MS, max = RECENTLY_ENDED_MAX, now = Date.now) {
    this.#graceMs = graceMs;
    this.#max = max;
    this.#now = now;
  }

  get size(): number {
    return this.#runs.size;
  }

  add(runId: string, threadId: string): void {
    this.#prune();
    this.#runs.delete(runId);
    this.#runs.set(runId, { threadId, at: this.#now() });
    if (this.#runs.size > this.#max) {
      const oldest = this.#runs.keys().next().value;
      if (oldest !== undefined) this.#runs.delete(oldest);
    }
  }

  match(runId: string, threadId: string): RecentMatch {
    this.#prune();
    const run = this.#runs.get(runId);
    if (run === undefined) return "none";
    return run.threadId === threadId ? "match" : "thread_mismatch";
  }

  /** Entries are kept in insertion (= time) order: drop expired ones from the front. */
  #prune(): void {
    const cutoff = this.#now() - this.#graceMs;
    for (const [runId, run] of this.#runs) {
      if (run.at > cutoff) return;
      this.#runs.delete(runId);
    }
  }
}

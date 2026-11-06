/**
 * Search hits opened from the Threads panel or the bar's search (CT15, KOBE-544): the hit waits
 * here until its thread's controller exists, which then shows the hit's branch; and whether a
 * hit is off its thread's leaf branch, once the thread's entries told (the rail's "on another
 * branch" note). Per tab, in memory.
 */
type Listener = () => void;

/** A hit not taken by its thread within this long is dropped (it never moves a head later). */
export const SEARCH_HIT_TTL_MS = 30_000;

export class SearchHitStore {
  #pending:
    { readonly threadId: string; readonly entryId: string; readonly at: number } | undefined;
  readonly #offBranch = new Map<string, boolean>();
  readonly #listeners = new Set<Listener>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** A hit was opened before its thread's controller was held (one at a time: the newest). */
  open(threadId: string, entryId: string): void {
    this.#pending = { threadId, entryId, at: this.#now() };
  }

  /**
   * A thread's controller is acquired: its hit, if one waits and is fresh. Any other thread
   * acquired first drops the waiting hit.
   */
  take(threadId: string): string | undefined {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending === undefined || pending.threadId !== threadId) return undefined;
    return this.#now() - pending.at <= SEARCH_HIT_TTL_MS ? pending.entryId : undefined;
  }

  /** What the thread's entries say about a hit (off the leaf's branch or not). */
  report(threadId: string, entryId: string, offBranch: boolean): void {
    const key = `${threadId}:${entryId}`;
    if (this.#offBranch.get(key) === offBranch) return;
    this.#offBranch.set(key, offBranch);
    for (const listener of this.#listeners) listener();
  }

  /** True when known off the leaf's branch; undefined until the thread has been read. */
  offBranch(threadId: string, entryId: string): boolean | undefined {
    return this.#offBranch.get(`${threadId}:${entryId}`);
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}

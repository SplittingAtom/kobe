/**
 * Search hits opened from the Threads panel or the bar's search (CT15, KOBE-544): the hit waits
 * here until its thread's controller exists, which then shows the hit's branch; and whether a
 * hit is off its thread's leaf branch, once the thread's entries told (the rail's "on another
 * branch" note). Per tab, in memory.
 */
type Listener = () => void;

export class SearchHitStore {
  readonly #pending = new Map<string, string>();
  readonly #offBranch = new Map<string, boolean>();
  readonly #listeners = new Set<Listener>();

  /** A hit was opened before its thread's controller was held. */
  open(threadId: string, entryId: string): void {
    this.#pending.set(threadId, entryId);
  }

  /** The hit waiting for this thread, once. */
  take(threadId: string): string | undefined {
    const entryId = this.#pending.get(threadId);
    this.#pending.delete(threadId);
    return entryId;
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

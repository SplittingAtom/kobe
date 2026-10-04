/**
 * Audit throttle for refusals a hostile sandbox controls (KOBE-37). One row per key per window;
 * repeats inside the window are counted and reported as `suppressed` on the key's next row, so a
 * flood leaves a bounded trail that still says how much happened. Keys are fine-grained (tool call
 * id + reason), so varied forged attempts each leave their own first row. Bounded memory: expired
 * keys are pruned, then the oldest go first (a key dropped with pending repeats loses only its
 * count, never its first row).
 */
export class AuditThrottle {
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #seen = new Map<string, { at: number; suppressed: number }>();

  constructor(options: { windowMs?: number; maxKeys?: number; now?: () => number } = {}) {
    this.#windowMs = options.windowMs ?? 5 * 60_000;
    this.#maxKeys = options.maxKeys ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Whether to write a row for `key` now; when yes, how many repeats were suppressed since its
   * last row.
   */
  take(
    key: string,
  ): { readonly record: false } | { readonly record: true; readonly suppressed: number } {
    const now = this.#now();
    const entry = this.#seen.get(key);
    if (entry && now - entry.at < this.#windowMs) {
      entry.suppressed += 1;
      return { record: false };
    }
    const suppressed = entry?.suppressed ?? 0;
    this.#seen.delete(key);
    this.#seen.set(key, { at: now, suppressed: 0 });
    this.#prune(now);
    return { record: true, suppressed };
  }

  get size(): number {
    return this.#seen.size;
  }

  #prune(now: number): void {
    if (this.#seen.size <= this.#maxKeys) return;
    for (const [key, entry] of this.#seen) {
      if (now - entry.at >= this.#windowMs) this.#seen.delete(key);
    }
    for (const key of this.#seen.keys()) {
      if (this.#seen.size <= this.#maxKeys) break;
      this.#seen.delete(key);
    }
  }
}

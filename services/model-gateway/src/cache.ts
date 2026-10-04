/**
 * A small TTL cache with single-flight loads: concurrent misses for one key share one load, so a
 * burst of calls from one sandbox costs one database transaction, not one each.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { readonly at: number; readonly value: V }>();
  private readonly loading = new Map<string, Promise<V>>();
  /** Bumped by every invalidation: a load that began under an older one is not cached. */
  private generation = 0;

  constructor(
    private readonly options: {
      readonly ttlMs: number;
      readonly maxEntries?: number;
      readonly now?: () => number;
      /** Values not to keep (e.g. "not ready yet" answers that should be asked again). */
      readonly keep?: (value: V) => boolean;
    },
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  async get(key: string, load: () => Promise<V>, fresh = false): Promise<V> {
    const hit = this.entries.get(key);
    if (!fresh && hit && this.now() - hit.at < this.options.ttlMs) return hit.value;
    const pending = this.loading.get(key);
    if (pending && !fresh) return pending;
    const generation = this.generation;
    const p = (async () => {
      try {
        const value = await load();
        if (generation === this.generation && (this.options.keep?.(value) ?? true)) {
          if (this.entries.size >= (this.options.maxEntries ?? 10_000)) this.entries.clear();
          this.entries.set(key, { at: this.now(), value });
        }
        return value;
      } finally {
        if (generation === this.generation) this.loading.delete(key);
      }
    })();
    this.loading.set(key, p);
    return p;
  }

  deleteWhere(match: (key: string) => boolean): void {
    this.generation++;
    this.loading.clear();
    for (const key of this.entries.keys()) if (match(key)) this.entries.delete(key);
  }

  clear(): void {
    this.generation++;
    this.loading.clear();
    this.entries.clear();
  }
}

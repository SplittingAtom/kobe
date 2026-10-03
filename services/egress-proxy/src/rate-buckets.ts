/**
 * Keyed token buckets for event rates (reports, audit keys, log lines): `take(key)` spends one
 * token and says whether it was there. Buckets refill at `perSecond` up to `burst`; the map is
 * bounded (oldest key evicted first), so an attacker rotating keys can't grow memory.
 */
export interface RateBucketsOptions {
  readonly burst: number;
  readonly perSecond: number;
  readonly maxKeys?: number;
  readonly now?: () => number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class RateBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(private readonly options: RateBucketsOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  take(key: string): boolean {
    const now = this.now();
    const existing = this.buckets.get(key);
    const bucket = existing ?? { tokens: this.options.burst, at: now };
    bucket.tokens = Math.min(
      this.options.burst,
      bucket.tokens + ((now - bucket.at) / 1000) * this.options.perSecond,
    );
    bucket.at = now;
    // Re-insert so the map's order is least recently used first.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > (this.options.maxKeys ?? 10_000)) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

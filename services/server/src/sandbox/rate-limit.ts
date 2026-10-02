/**
 * Per-source token bucket (per server process). Guards the sandbox session exchange, where every
 * request costs a TokenReview against the Kubernetes API.
 */
export interface RateLimiterOptions {
  /** Burst size. */
  readonly capacity: number;
  /** Tokens added per second. */
  readonly refillPerSecond: number;
  /** Tracked sources at most; beyond it, idle (full) buckets are dropped first. */
  readonly maxSources?: number;
  readonly now?: () => number;
}

export interface RateLimiter {
  /** Takes one token for `source`; returns 0 when allowed, else ms until the next token. */
  take(source: string): number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { capacity, refillPerSecond, maxSources = 10_000, now = () => Date.now() } = options;
  const buckets = new Map<string, { tokens: number; at: number }>();

  const level = (b: { tokens: number; at: number }, t: number) =>
    Math.min(capacity, b.tokens + ((t - b.at) / 1000) * refillPerSecond);

  const prune = (t: number) => {
    for (const [key, b] of buckets) if (level(b, t) >= capacity) buckets.delete(key);
    // Still too many active sources: drop the oldest entries (Map keeps insertion order).
    for (const key of buckets.keys()) {
      if (buckets.size < maxSources) break;
      buckets.delete(key);
    }
  };

  return {
    take(source) {
      const t = now();
      const existing = buckets.get(source);
      if (!existing && buckets.size >= maxSources) prune(t);
      const tokens = existing ? level(existing, t) : capacity;
      if (tokens >= 1) {
        buckets.delete(source);
        buckets.set(source, { tokens: tokens - 1, at: t });
        return 0;
      }
      buckets.set(source, { tokens, at: t });
      return Math.ceil(((1 - tokens) / refillPerSecond) * 1000);
    },
  };
}

/**
 * Per-sandbox and per-replica limits (KOBE-58): request rate (token bucket per sandbox) and
 * concurrent upstream calls (per sandbox and in total). Per replica, like the egress proxy's.
 */
export interface LimiterOptions {
  readonly burst: number;
  readonly perSecond: number;
  readonly callsPerSandbox: number;
  readonly maxConcurrentCalls: number;
  /** Tracked sandboxes at most (oldest idle buckets dropped first). */
  readonly maxSandboxes?: number;
  readonly now?: () => number;
}

export interface Limiter {
  /** Takes one request token for the sandbox; false = rate limited. */
  takeRequest(sandboxId: string): boolean;
  /** Reserves a call slot; returns a release function, or undefined when at a limit. */
  acquireCall(sandboxId: string): (() => void) | undefined;
  readonly activeCalls: number;
}

export function createLimiter(options: LimiterOptions): Limiter {
  const now = options.now ?? (() => Date.now());
  const maxSandboxes = options.maxSandboxes ?? 10_000;
  const buckets = new Map<string, { tokens: number; at: number }>();
  const calls = new Map<string, number>();
  let total = 0;

  const level = (b: { tokens: number; at: number }, t: number) =>
    Math.min(options.burst, b.tokens + ((t - b.at) / 1000) * options.perSecond);

  return {
    takeRequest(sandboxId) {
      const t = now();
      const existing = buckets.get(sandboxId);
      if (!existing && buckets.size >= maxSandboxes) {
        for (const [k, b] of buckets) if (level(b, t) >= options.burst) buckets.delete(k);
        const oldest = buckets.keys().next();
        if (buckets.size >= maxSandboxes && !oldest.done) buckets.delete(oldest.value);
      }
      const tokens = existing ? level(existing, t) : options.burst;
      buckets.delete(sandboxId);
      if (tokens < 1) {
        buckets.set(sandboxId, { tokens, at: t });
        return false;
      }
      buckets.set(sandboxId, { tokens: tokens - 1, at: t });
      return true;
    },
    acquireCall(sandboxId) {
      const mine = calls.get(sandboxId) ?? 0;
      if (mine >= options.callsPerSandbox || total >= options.maxConcurrentCalls) return undefined;
      calls.set(sandboxId, mine + 1);
      total += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        total -= 1;
        const left = (calls.get(sandboxId) ?? 1) - 1;
        if (left <= 0) calls.delete(sandboxId);
        else calls.set(sandboxId, left);
      };
    },
    get activeCalls() {
      return total;
    },
  };
}

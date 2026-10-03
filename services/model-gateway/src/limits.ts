/**
 * Concurrent calls per sandbox and per replica (abuse bound, not a budget): beyond either the shim
 * answers 429 before contacting Bifrost.
 */
export class CallLimiter {
  private readonly perSandbox = new Map<string, number>();
  private total = 0;

  constructor(private readonly limits: { readonly perSandbox: number; readonly total: number }) {}

  /** A release function, or undefined when a limit is reached. */
  acquire(sandboxId: string): (() => void) | undefined {
    const current = this.perSandbox.get(sandboxId) ?? 0;
    if (current >= this.limits.perSandbox || this.total >= this.limits.total) return undefined;
    this.perSandbox.set(sandboxId, current + 1);
    this.total++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const n = (this.perSandbox.get(sandboxId) ?? 1) - 1;
      if (n <= 0) this.perSandbox.delete(sandboxId);
      else this.perSandbox.set(sandboxId, n);
    };
  }

  get active(): number {
    return this.total;
  }
}

/**
 * Request bytes held in memory at once (KOBE-40 review: bodies are buffered to read the model and
 * to retry once): per sandbox and per replica. A request takes its bytes before it is read
 * (declared length) or as they arrive (chunked); beyond either budget it is refused (429), so a
 * sandbox cannot run the shim out of memory for every team.
 */
export class ByteBudget {
  private readonly perSandbox = new Map<string, number>();
  private total = 0;

  constructor(private readonly limits: { readonly perSandbox: number; readonly total: number }) {}

  tryTake(sandboxId: string, bytes: number): boolean {
    const current = this.perSandbox.get(sandboxId) ?? 0;
    if (current + bytes > this.limits.perSandbox || this.total + bytes > this.limits.total) {
      return false;
    }
    this.perSandbox.set(sandboxId, current + bytes);
    this.total += bytes;
    return true;
  }

  give(sandboxId: string, bytes: number): void {
    if (bytes <= 0) return;
    this.total = Math.max(0, this.total - bytes);
    const n = (this.perSandbox.get(sandboxId) ?? 0) - bytes;
    if (n <= 0) this.perSandbox.delete(sandboxId);
    else this.perSandbox.set(sandboxId, n);
  }

  get used(): number {
    return this.total;
  }
}

/**
 * Requests per sandbox (token bucket: `burst`, refilled at `perSecond`), checked right after the
 * token, before anything touches the database: a sandbox cannot turn invalid run ids or retries
 * into database load for every team.
 */
export class RequestRate {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly limits: { readonly burst: number; readonly perSecond: number },
    private readonly now: () => number = Date.now,
  ) {}

  allow(sandboxId: string): boolean {
    const t = this.now();
    const b = this.buckets.get(sandboxId) ?? { tokens: this.limits.burst, at: t };
    const tokens = Math.min(
      this.limits.burst,
      b.tokens + ((t - b.at) / 1000) * this.limits.perSecond,
    );
    if (this.buckets.size > 10_000) this.buckets.clear();
    if (tokens < 1) {
      this.buckets.set(sandboxId, { tokens, at: t });
      return false;
    }
    this.buckets.set(sandboxId, { tokens: tokens - 1, at: t });
    return true;
  }
}

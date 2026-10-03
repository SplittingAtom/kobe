/**
 * Per-sandbox resource limits of the egress proxy: concurrent tunnels (per sandbox and in total)
 * and bandwidth (one token bucket per sandbox, shared by all its tunnels and both directions).
 */
export interface ConnectionLimitsOptions {
  readonly perSandbox: number;
  readonly total: number;
}

export class ConnectionLimits {
  private readonly bySandbox = new Map<string, number>();
  private total = 0;

  constructor(private readonly options: ConnectionLimitsOptions) {}

  /** A release function, or null when the sandbox (or the proxy) is at its limit. */
  tryAcquire(sandboxId: string): (() => void) | null {
    const current = this.bySandbox.get(sandboxId) ?? 0;
    if (current >= this.options.perSandbox || this.total >= this.options.total) return null;
    this.bySandbox.set(sandboxId, current + 1);
    this.total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const left = (this.bySandbox.get(sandboxId) ?? 1) - 1;
      if (left <= 0) this.bySandbox.delete(sandboxId);
      else this.bySandbox.set(sandboxId, left);
    };
  }

  active(sandboxId?: string): number {
    return sandboxId === undefined ? this.total : (this.bySandbox.get(sandboxId) ?? 0);
  }
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  users: number;
}

/**
 * Token buckets in bytes per second. `take` charges a chunk that has already been forwarded and
 * returns how long the caller should pause reading so the sandbox stays at its rate on average
 * (burst: one second's worth). Rate 0 disables the limit.
 */
export class BandwidthLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly bytesPerSecond: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Registers a tunnel of `sandboxId`; the returned function unregisters it. */
  attach(sandboxId: string): () => void {
    const bucket = this.buckets.get(sandboxId) ?? {
      tokens: this.bytesPerSecond,
      updatedAt: this.now(),
      users: 0,
    };
    bucket.users += 1;
    this.buckets.set(sandboxId, bucket);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      bucket.users -= 1;
      if (bucket.users <= 0) this.buckets.delete(sandboxId);
    };
  }

  /** Milliseconds to wait before reading more (0: go on). */
  take(sandboxId: string, bytes: number): number {
    if (this.bytesPerSecond <= 0) return 0;
    const bucket = this.buckets.get(sandboxId);
    if (!bucket) return 0;
    const now = this.now();
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(
      this.bytesPerSecond,
      bucket.tokens + (elapsed * this.bytesPerSecond) / 1000,
    );
    bucket.updatedAt = now;
    bucket.tokens -= bytes;
    if (bucket.tokens >= 0) return 0;
    return Math.ceil((-bucket.tokens * 1000) / this.bytesPerSecond);
  }
}

/**
 * Per-process limits on OAuth refreshes (KOBE-110). Refreshing calls an external server, so it
 * must never hold a database connection and must not fan out:
 * - single-flight per grant: concurrent callers in this process share one refresh;
 * - at most `maxConcurrent` refreshes at once (extra ones queue without holding anything);
 * - after a transient failure a grant is left alone for `backoffMs`, so a slow or hostile token
 *   endpoint is not hammered by every tool call.
 * Across replicas the database compare-and-set decides the winner; this is only a courtesy.
 */
export interface RefreshGateOptions {
  readonly maxConcurrent?: number;
  readonly backoffMs?: number;
  readonly now?: () => number;
}

export class RefreshGate {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly retryAfter = new Map<string, number>();
  private readonly queue: (() => void)[] = [];
  private active = 0;
  private readonly maxConcurrent: number;
  private readonly backoffMs: number;
  private readonly now: () => number;

  constructor(options: RefreshGateOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.backoffMs = options.backoffMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  inBackoff(key: string): boolean {
    const until = this.retryAfter.get(key);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.retryAfter.delete(key);
    return false;
  }

  markFailed(key: string): void {
    const now = this.now();
    for (const [k, until] of this.retryAfter) if (until <= now) this.retryAfter.delete(k);
    this.retryAfter.set(key, now + this.backoffMs);
  }

  clear(key: string): void {
    this.retryAfter.delete(key);
  }

  /** Runs `fn` once for all concurrent callers of `key`. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const flight = this.slot().then(async () => {
      try {
        return await fn();
      } finally {
        this.release();
      }
    });
    const tracked = flight.finally(() => this.inflight.delete(key));
    this.inflight.set(key, tracked);
    return tracked;
  }

  private slot(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active -= 1;
  }
}

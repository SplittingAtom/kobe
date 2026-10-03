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

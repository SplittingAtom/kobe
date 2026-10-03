import type { Socket } from "node:net";

/**
 * Bounds sockets that have not authenticated yet (KOBE-38 review): per source address (one
 * sandbox pod = one IP) and in total, separately from the authenticated tunnel limit, so one
 * sandbox opening thousands of idle or slow-loris connections exhausts only its own share and
 * never the capacity other teams' tunnels use. A socket leaves the gate when it authenticates
 * (`authenticated`) or closes.
 */
export interface PreAuthGateOptions {
  readonly perSource: number;
  readonly total: number;
}

export class PreAuthGate {
  private readonly bySource = new Map<string, number>();
  private readonly holding = new WeakMap<Socket, string>();
  private count = 0;
  /** Sockets refused since the last `drainRefused()` (for a summary log line). */
  private refusedCount = 0;

  constructor(private readonly options: PreAuthGateOptions) {}

  /** Admits a new socket or destroys it; returns whether it was admitted. */
  admit(socket: Socket): boolean {
    const source = socket.remoteAddress ?? "unknown";
    const current = this.bySource.get(source) ?? 0;
    if (current >= this.options.perSource || this.count >= this.options.total) {
      this.refusedCount += 1;
      socket.destroy();
      return false;
    }
    this.bySource.set(source, current + 1);
    this.count += 1;
    this.holding.set(socket, source);
    socket.once("close", () => this.release(socket));
    return true;
  }

  /** The socket authenticated: it no longer counts against the pre-auth limits. */
  authenticated(socket: Socket): void {
    this.release(socket);
  }

  pending(source?: string): number {
    return source === undefined ? this.count : (this.bySource.get(source) ?? 0);
  }

  drainRefused(): number {
    const n = this.refusedCount;
    this.refusedCount = 0;
    return n;
  }

  private release(socket: Socket): void {
    const source = this.holding.get(socket);
    if (source === undefined) return;
    this.holding.delete(socket);
    this.count -= 1;
    const left = (this.bySource.get(source) ?? 1) - 1;
    if (left <= 0) this.bySource.delete(source);
    else this.bySource.set(source, left);
  }
}

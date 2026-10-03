import type { Logger } from "pino";
import type { ProxyPolicy } from "./proxy.js";

/**
 * Open tunnels, so revocation reaches connections that are already established (KOBE-38 review):
 * when a change hint arrives (domain disabled, ceiling changed, member removed or deactivated) the
 * affected tunnels are re-checked against the fresh allowlist and closed if no longer allowed. A
 * periodic re-check bounds anything a hint missed. Lifetime limits (token expiry, max tunnel age)
 * are timers on each tunnel.
 */
export interface LiveTunnel {
  readonly teamId: string;
  readonly userId: string;
  readonly host: string;
  close(reason: string): void;
}

export type TunnelScope =
  | { readonly kind: "all" }
  | { readonly kind: "ceiling" }
  | { readonly kind: "team"; readonly teamId: string }
  | { readonly kind: "user"; readonly userId: string };

export class TunnelRegistry {
  private readonly tunnels = new Set<LiveTunnel>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly policy: ProxyPolicy,
    private readonly logger: Logger,
  ) {}

  /** Registers a tunnel; closes it at `closeAt` (ms epoch). Returns the unregister function. */
  register(tunnel: LiveTunnel, closeAt: number): () => void {
    this.tunnels.add(tunnel);
    const timer = setTimeout(
      () => tunnel.close("lifetime"),
      Math.max(0, Math.min(closeAt - Date.now(), 2_147_000_000)),
    );
    timer.unref();
    return () => {
      clearTimeout(timer);
      this.tunnels.delete(tunnel);
    };
  }

  get size(): number {
    return this.tunnels.size;
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.recheck({ kind: "all" }), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Re-decides every tunnel in scope; closes those no longer allowed. Errors keep the tunnel. */
  async recheck(scope: TunnelScope): Promise<number> {
    const affected = [...this.tunnels].filter(
      (t) =>
        scope.kind === "all" ||
        scope.kind === "ceiling" ||
        (scope.kind === "team" && t.teamId === scope.teamId) ||
        (scope.kind === "user" && t.userId === scope.userId),
    );
    let closed = 0;
    for (const tunnel of affected) {
      try {
        const member = await this.policy.isActiveMember(tunnel.teamId, tunnel.userId);
        const decision = member ? await this.policy.decide(tunnel.teamId, tunnel.host) : undefined;
        if (!decision?.allowed) {
          tunnel.close(member ? "revoked" : "inactive_member");
          closed += 1;
        }
      } catch (err) {
        this.logger.warn({ err, team: tunnel.teamId }, "egress tunnel re-check failed");
      }
    }
    return closed;
  }
}

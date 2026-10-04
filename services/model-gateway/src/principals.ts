import { virtualKeyContext, type GatewayPrincipal, type SecretBox } from "@kobe/db";
import { TtlCache } from "./cache.js";

/**
 * Who may call a model (KOBE-40): a verified `kobe.model-gateway` token is not enough on its own.
 * Its (team, user) must still be an active membership and its sandbox not revoked (destroyed,
 * hibernated or replaced, per the KOBE-25 `sandboxes` row), and the member must have a virtual key
 * (written by the server's gateway sync). The answer also carries the team's enabled models, which
 * the shim enforces itself. Answers are cached for `ttlMs` (the revocation latency bound), loaded
 * once for concurrent callers, and dropped on `keys:<team>` hints.
 */
export interface PrincipalStore {
  load(teamId: string, userId: string, sandboxId: string): Promise<GatewayPrincipal>;
  /** Asks the gateway sync for this member's virtual key (NOTIFY `ensure:<team>:<user>`). */
  requestKey(teamId: string, userId: string): Promise<void>;
}

export type Resolution =
  | {
      readonly ok: true;
      readonly virtualKey: string;
      /** `<gateway provider>/<model>` ids the team enabled. */
      readonly enabledModels: ReadonlySet<string>;
    }
  | {
      readonly ok: false;
      readonly reason: "not_member" | "sandbox_revoked" | "no_key" | "key_unreadable";
    };

export interface PrincipalCacheOptions {
  readonly ttlMs: number;
  /** How long a first call waits for the sync to create a missing virtual key. */
  readonly keyWaitMs?: number;
  readonly keyPollMs?: number;
  /** Minimum time between two key requests for the same member. */
  readonly keyRequestEveryMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

export class PrincipalCache {
  private readonly cache: TtlCache<Resolution>;
  /** Last key request per member: at most one NOTIFY per member per `keyRequestEveryMs`. */
  private readonly requested = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly store: PrincipalStore,
    private readonly box: SecretBox,
    private readonly options: PrincipalCacheOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.cache = new TtlCache<Resolution>({
      ttlMs: options.ttlMs,
      ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
      now: this.now,
      // A missing key is not cached: the next call asks again.
      keep: (r) => r.ok || r.reason !== "no_key",
    });
  }

  resolve(teamId: string, userId: string, sandboxId: string, fresh = false): Promise<Resolution> {
    return this.cache.get(
      `${teamId}:${userId}:${sandboxId}`,
      async () => {
        const first = await this.load(teamId, userId, sandboxId);
        return !first.ok && first.reason === "no_key"
          ? this.waitForKey(teamId, userId, sandboxId)
          : first;
      },
      fresh,
    );
  }

  private async load(teamId: string, userId: string, sandboxId: string): Promise<Resolution> {
    const p = await this.store.load(teamId, userId, sandboxId);
    if (!p.member) return { ok: false, reason: "not_member" };
    if (p.sandbox === "revoked") return { ok: false, reason: "sandbox_revoked" };
    if (!p.virtualKey) return { ok: false, reason: "no_key" };
    try {
      return {
        ok: true,
        virtualKey: this.box.open(p.virtualKey.valueEnc, virtualKeyContext(teamId, userId)),
        enabledModels: new Set(p.enabledModels),
      };
    } catch {
      return { ok: false, reason: "key_unreadable" };
    }
  }

  private async waitForKey(teamId: string, userId: string, sandboxId: string): Promise<Resolution> {
    const member = `${teamId}:${userId}`;
    const requestedAt = this.requested.get(member);
    if (
      requestedAt === undefined ||
      this.now() - requestedAt >= (this.options.keyRequestEveryMs ?? 5_000)
    ) {
      if (this.requested.size >= (this.options.maxEntries ?? 10_000)) this.requested.clear();
      this.requested.set(member, this.now());
      await this.store.requestKey(teamId, userId);
    }
    const end = this.now() + (this.options.keyWaitMs ?? 10_000);
    let last: Resolution = { ok: false, reason: "no_key" };
    while (this.now() < end) {
      await new Promise((r) => setTimeout(r, this.options.keyPollMs ?? 500));
      last = await this.load(teamId, userId, sandboxId);
      if (last.ok || last.reason !== "no_key") return last;
    }
    return last;
  }

  invalidateTeam(teamId: string): void {
    this.cache.deleteWhere((key) => key.startsWith(`${teamId}:`));
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}

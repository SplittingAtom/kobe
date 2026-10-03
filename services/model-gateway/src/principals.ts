import { virtualKeyContext, type GatewayPrincipal, type SecretBox } from "@kobe/db";

/**
 * Who may call a model (KOBE-40): a verified `kobe.model-gateway` token is not enough on its own.
 * Its (team, user) must still be an active membership and its sandbox not revoked (destroyed,
 * hibernated or replaced, per the KOBE-25 `sandboxes` row), and the member must have a virtual key
 * (written by the server's gateway sync). Answers are cached for `ttlMs` (the revocation latency
 * bound) and dropped on `keys:<team>` hints.
 */
export interface PrincipalStore {
  load(teamId: string, userId: string, sandboxId: string): Promise<GatewayPrincipal>;
  /** Asks the gateway sync for this member's virtual key (NOTIFY `ensure:<team>:<user>`). */
  requestKey(teamId: string, userId: string): Promise<void>;
}

export type Resolution =
  | { readonly ok: true; readonly virtualKey: string }
  | {
      readonly ok: false;
      readonly reason: "not_member" | "sandbox_revoked" | "no_key" | "key_unreadable";
    };

export interface PrincipalCacheOptions {
  readonly ttlMs: number;
  /** How long a first call waits for the sync to create a missing virtual key. */
  readonly keyWaitMs?: number;
  readonly keyPollMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

interface Entry {
  readonly at: number;
  readonly resolution: Resolution;
}

export class PrincipalCache {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(
    private readonly store: PrincipalStore,
    private readonly box: SecretBox,
    private readonly options: PrincipalCacheOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async resolve(
    teamId: string,
    userId: string,
    sandboxId: string,
    fresh = false,
  ): Promise<Resolution> {
    const key = `${teamId}:${userId}:${sandboxId}`;
    const hit = this.entries.get(key);
    if (!fresh && hit && this.now() - hit.at < this.options.ttlMs) return hit.resolution;
    let resolution = await this.load(teamId, userId, sandboxId);
    if (!resolution.ok && resolution.reason === "no_key") {
      resolution = await this.waitForKey(teamId, userId, sandboxId);
    }
    if (this.entries.size >= (this.options.maxEntries ?? 10_000)) this.entries.clear();
    // A missing key is not cached: the next call asks again.
    if (resolution.ok || resolution.reason !== "no_key") {
      this.entries.set(key, { at: this.now(), resolution });
    }
    return resolution;
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
      };
    } catch {
      return { ok: false, reason: "key_unreadable" };
    }
  }

  private async waitForKey(teamId: string, userId: string, sandboxId: string): Promise<Resolution> {
    await this.store.requestKey(teamId, userId);
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
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${teamId}:`)) this.entries.delete(key);
    }
  }

  invalidateAll(): void {
    this.entries.clear();
  }
}

import { findMatchingPattern } from "@kobe/db";

/**
 * Per-team egress allowlists (spec D6, D28): effective(team) = team enablement ∩ install ceiling,
 * read from Postgres and cached. Change hints (LISTEN/NOTIFY, see change-listener.ts) invalidate
 * entries; a TTL bounds staleness anyway, and while the listener is down entries live only
 * `degradedTtlMs`. Generation counters make sure a load that started before an invalidation never
 * repopulates the cache with what it read. Failures propagate: the proxy fails closed.
 */
export interface EgressPolicySource {
  loadCeiling(): Promise<readonly string[]>;
  loadTeam(teamId: string): Promise<readonly string[]>;
  isActiveMember(teamId: string, userId: string): Promise<boolean>;
}

export type EgressDecision =
  | { readonly allowed: true; readonly pattern: string }
  | { readonly allowed: false; readonly reason: "not_enabled" | "not_in_ceiling" };

export interface AllowlistCacheOptions {
  readonly ttlMs: number;
  readonly degradedTtlMs: number;
  readonly memberTtlMs: number;
  readonly maxEntries: number;
  readonly now?: () => number;
}

interface Entry<T> {
  readonly value: T;
  readonly loadedAt: number;
  readonly gen: number;
}

export class AllowlistCache {
  private ceiling: Entry<ReadonlySet<string>> | undefined;
  private readonly teams = new Map<string, Entry<ReadonlySet<string>>>();
  private readonly members = new Map<string, Entry<boolean>>();
  private readonly inflight = new Map<string, { gen: number; promise: Promise<unknown> }>();
  /** Bumped by invalidateAll (every entry); the ceiling also has its own counter. */
  private allGen = 0;
  private ceilingGen = 0;
  private readonly teamGen = new Map<string, number>();
  private readonly userGen = new Map<string, number>();
  private listening = false;
  private readonly now: () => number;

  constructor(
    private readonly source: EgressPolicySource,
    private readonly options: AllowlistCacheOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Whether change hints are arriving (entries then live `ttlMs`, else `degradedTtlMs`). */
  setListening(listening: boolean): void {
    this.listening = listening;
  }

  invalidateAll(): void {
    this.allGen += 1;
    this.ceiling = undefined;
    this.teams.clear();
    this.members.clear();
  }

  invalidateCeiling(): void {
    // Effective lists are computed per decision, so only the ceiling entry goes.
    this.ceilingGen += 1;
    this.ceiling = undefined;
  }

  invalidateTeam(teamId: string): void {
    this.teamGen.set(teamId, (this.teamGen.get(teamId) ?? 0) + 1);
    this.teams.delete(teamId);
    for (const key of this.members.keys())
      if (key.startsWith(`${teamId}:`)) this.members.delete(key);
  }

  /** A user's membership changed somewhere (removed, deactivated): forget it in every team. */
  invalidateUser(userId: string): void {
    for (const key of this.members.keys()) if (key.endsWith(`:${userId}`)) this.members.delete(key);
    this.userGen.set(userId, (this.userGen.get(userId) ?? 0) + 1);
  }

  async decide(teamId: string, host: string): Promise<EgressDecision> {
    const [ceiling, team] = await Promise.all([this.getCeiling(), this.getTeam(teamId)]);
    const effective = new Set([...team].filter((p) => ceiling.has(p)));
    const pattern = findMatchingPattern(effective, host);
    if (pattern !== undefined) return { allowed: true, pattern };
    return {
      allowed: false,
      reason: findMatchingPattern(ceiling, host) === undefined ? "not_in_ceiling" : "not_enabled",
    };
  }

  isActiveMember(teamId: string, userId: string): Promise<boolean> {
    const key = `${teamId}:${userId}`;
    return this.cached(
      key,
      () => this.members.get(key),
      (e) => this.store(this.members, key, e),
      () => this.source.isActiveMember(teamId, userId),
      this.memberGeneration(teamId, userId),
      this.options.memberTtlMs,
    );
  }

  private getCeiling(): Promise<ReadonlySet<string>> {
    return this.cached(
      "ceiling",
      () => this.ceiling,
      (e) => {
        this.ceiling = e;
      },
      async () => new Set(await this.source.loadCeiling()),
      this.ceilingGeneration(),
      this.ttl(),
    );
  }

  private getTeam(teamId: string): Promise<ReadonlySet<string>> {
    return this.cached(
      `team:${teamId}`,
      () => this.teams.get(teamId),
      (e) => this.store(this.teams, teamId, e),
      async () => new Set(await this.source.loadTeam(teamId)),
      this.generation(teamId),
      this.ttl(),
    );
  }

  private ttl(): number {
    return this.listening ? this.options.ttlMs : this.options.degradedTtlMs;
  }

  // Combined so that invalidateAll changes every generation too.
  private ceilingGeneration(): number {
    return this.allGen * 1_000_003 + this.ceilingGen;
  }

  private memberGeneration(teamId: string, userId: string): number {
    return this.generation(teamId) * 1_000_003 + (this.userGen.get(userId) ?? 0);
  }

  private generation(teamId: string): number {
    return this.allGen * 1_000_003 + (this.teamGen.get(teamId) ?? 0);
  }

  private store<T>(map: Map<string, Entry<T>>, key: string, entry: Entry<T>): void {
    if (!map.has(key) && map.size >= this.options.maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, entry);
  }

  private async cached<T>(
    key: string,
    read: () => Entry<T> | undefined,
    write: (e: Entry<T>) => void,
    load: () => Promise<T>,
    gen: number,
    ttlMs: number,
  ): Promise<T> {
    const hit = read();
    if (hit && hit.gen === gen && this.now() - hit.loadedAt < ttlMs) return hit.value;
    const pending = this.inflight.get(key);
    if (pending && pending.gen === gen) return pending.promise as Promise<T>;
    const loadedAt = this.now();
    const promise = load().then(
      (value) => {
        if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key);
        // Invalidated while loading: hand the value to this caller but don't cache it.
        if (this.currentGen(key) === gen) write({ value, loadedAt, gen });
        return value;
      },
      (err: unknown) => {
        if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key);
        throw err;
      },
    );
    this.inflight.set(key, { gen, promise });
    return promise;
  }

  private currentGen(key: string): number {
    if (key === "ceiling") return this.ceilingGeneration();
    if (key.startsWith("team:")) return this.generation(key.slice(5));
    const [teamId = "", userId = ""] = key.split(":");
    return this.memberGeneration(teamId, userId);
  }
}

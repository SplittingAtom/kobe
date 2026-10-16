/**
 * The replica's budget for relayed sandbox spans (KOBE-274): a token bucket for the whole replica
 * plus one per team at a fixed share of it, so one team's runs can never take the whole relay.
 * Spans over either bucket are dropped (and counted by the caller), never queued.
 */
export interface RelayBudgetOptions {
  /** Spans per second the replica relays, and its burst. */
  readonly perSecond: number;
  readonly burst: number;
  /** A team's share of both (0 < share <= 1). */
  readonly teamShare: number;
  /** Teams tracked at most; idle ones are forgotten first. */
  readonly maxTeams: number;
}

export const RELAY_BUDGET_DEFAULTS: RelayBudgetOptions = {
  perSecond: 2_000,
  burst: 4_000,
  teamShare: 0.25,
  maxTeams: 1_024,
};

interface Bucket {
  readonly tokens: number;
  readonly at: number;
}

function refill(bucket: Bucket, now: number, perSecond: number, burst: number): Bucket {
  const elapsed = Math.max(0, now - bucket.at) / 1000;
  return { tokens: Math.min(burst, bucket.tokens + elapsed * perSecond), at: now };
}

export class RelayBudget {
  readonly #options: RelayBudgetOptions;
  readonly #now: () => number;
  #replica: Bucket;
  readonly #teams = new Map<string, Bucket>();

  constructor(options: RelayBudgetOptions = RELAY_BUDGET_DEFAULTS, now: () => number = Date.now) {
    this.#options = options;
    this.#now = now;
    this.#replica = { tokens: options.burst, at: now() };
  }

  /** Takes up to `wanted` spans for `teamId`; returns how many may be relayed. */
  take(teamId: string, wanted: number): number {
    const { perSecond, burst, teamShare, maxTeams } = this.#options;
    const now = this.#now();
    this.#replica = refill(this.#replica, now, perSecond, burst);
    const teamBurst = burst * teamShare;
    const known = this.#teams.get(teamId);
    const team = refill(
      known ?? { tokens: teamBurst, at: now },
      now,
      perSecond * teamShare,
      teamBurst,
    );
    const granted = Math.max(
      0,
      Math.min(wanted, Math.floor(this.#replica.tokens), Math.floor(team.tokens)),
    );
    this.#replica = { ...this.#replica, tokens: this.#replica.tokens - granted };
    this.#teams.delete(teamId);
    this.#teams.set(teamId, { ...team, tokens: team.tokens - granted });
    if (this.#teams.size > maxTeams) {
      const oldest = this.#teams.keys().next().value;
      if (oldest !== undefined) this.#teams.delete(oldest);
    }
    return granted;
  }
}

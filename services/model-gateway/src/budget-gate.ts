import { exhaustedLine, type BudgetLine, type MemberBudgetState, type ModelPrice } from "@kobe/db";
import { TtlCache } from "./cache.js";
import { chargedOutput } from "./usage/charge.js";
import type { CallContext, CallGate, GateDecision } from "./seams.js";

/**
 * Kobe's own enforcement of budgets and per-user rate limits (KOBE-42, D30), at the identities the
 * session token proves: install, team and user (never the advisory run id, KOBE-41). A call is
 * refused **before** it reaches Bifrost; a call already forwarded is never cut, so the step in
 * flight finishes. The server's budget monitor then ends the runs (`stopForBudget`).
 *
 * - A used-up budget, in dollars or in tokens (spend ≥ limit for the month or the day, at any
 *   level; token budgets also cap models without catalog prices): 402
 *   `budget_exhausted`. Spend is what the `run_usage` ledger holds (written within about a second
 *   of a call ending); the state is cached for `ttlMs` and dropped on `spend:` / `budgets:` hints.
 * - **In-flight reservations** (KOBE-42 review): an admitted call reserves what it may cost (its
 *   input estimate plus the output it allows, `usage/charge.ts`; dollars at the catalog price) at
 *   its install, team and member levels until it ends, and a call is refused when spend plus the
 *   others' reservations reach a budget. Concurrent calls (many sandboxes of one team) therefore
 *   cannot together overshoot a budget by more than one call per shim replica.
 * - More requests than the member's per-minute rate (the install's, or the team's lower one): 429
 *   `rate_limited` with Retry-After. A token bucket per member per shim replica; Bifrost's
 *   virtual-key rate limit is the install-wide backstop.
 */
export interface BudgetStore {
  load(teamId: string, userId: string): Promise<MemberBudgetState>;
  /** Catalog prices by gateway model (cached by the gate). */
  prices(): Promise<ReadonlyMap<string, ModelPrice>>;
}

interface Reserved {
  usd: number;
  tokens: number;
}

/** The reservation keys of a member's levels. */
const reservationKeys = (teamId: string, userId: string) => ({
  install: "install",
  team: `team:${teamId}`,
  user: `user:${teamId}:${userId}`,
});

const SCOPE_NAMES: Readonly<Record<BudgetLine["scope"], string>> = {
  install: "The install's",
  team: "Your team's",
  user: "Your",
};

export function budgetMessage(line: BudgetLine): string {
  const kind = line.unit === "tokens" ? "token" : "model";
  return `${SCOPE_NAMES[line.scope]} ${line.period === "month" ? "monthly" : "daily"} ${kind} budget is used up.`;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class BudgetGate implements CallGate {
  private readonly states: TtlCache<MemberBudgetState>;
  private readonly buckets = new Map<string, Bucket>();
  private readonly reserved = new Map<string, Reserved>();
  private readonly priceCache: TtlCache<ReadonlyMap<string, ModelPrice>>;
  private readonly now: () => number;

  constructor(
    private readonly store: BudgetStore,
    options: { readonly ttlMs: number; readonly now?: () => number; readonly maxEntries?: number },
  ) {
    this.now = options.now ?? Date.now;
    this.states = new TtlCache<MemberBudgetState>({
      ttlMs: options.ttlMs,
      now: this.now,
      ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
    });
    this.priceCache = new TtlCache({ ttlMs: Math.max(options.ttlMs, 5_000), now: this.now });
  }

  async admit(call: CallContext): Promise<GateDecision> {
    const key = `${call.teamId}:${call.userId}`;
    const state = await this.states.get(key, () => this.store.load(call.teamId, call.userId));
    const used = exhaustedLine(state.lines);
    if (used) {
      return { ok: false, status: 402, code: "budget_exhausted", message: budgetMessage(used) };
    }
    const keys = reservationKeys(call.teamId, call.userId);
    const full = state.lines.find((l) => {
      const r = this.reserved.get(keys[l.scope]);
      return r !== undefined && l.spent + r[l.unit] >= l.limit;
    });
    if (full) {
      return { ok: false, status: 402, code: "budget_exhausted", message: budgetMessage(full) };
    }
    const wait = this.take(key, state.requestsPerMinute);
    if (wait > 0) {
      return {
        ok: false,
        status: 429,
        code: "rate_limited",
        message: "Too many model requests for this user; slow down.",
        retryAfterSeconds: wait,
      };
    }
    if (state.lines.length === 0) return { ok: true };
    return { ok: true, release: await this.reserve(call, keys) };
  }

  /** Reserves the call's possible cost at its levels; returns the release. */
  private async reserve(
    call: CallContext,
    keys: ReturnType<typeof reservationKeys>,
  ): Promise<() => void> {
    const input = call.inputEstimate ?? 0;
    const output = chargedOutput(call.requestedOutput);
    const prices = await this.priceCache.get("prices", () => this.store.prices());
    const price = call.model ? prices.get(call.model) : undefined;
    const cost: Reserved = {
      tokens: input + output,
      usd: price ? (input * price.input + output * price.output) / 1_000_000 : 0,
    };
    const all = [keys.install, keys.team, keys.user];
    for (const k of all) this.add(k, cost, 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const k of all) this.add(k, cost, -1);
    };
  }

  private add(key: string, cost: Reserved, sign: 1 | -1): void {
    const r = this.reserved.get(key) ?? { usd: 0, tokens: 0 };
    const next = { usd: r.usd + sign * cost.usd, tokens: r.tokens + sign * cost.tokens };
    if (next.tokens <= 0 && next.usd <= 1e-12) this.reserved.delete(key);
    else this.reserved.set(key, next);
  }

  /** Takes one request from the member's bucket; 0 when allowed, else seconds until one is. */
  private take(key: string, perMinute: number): number {
    const t = this.now();
    const refill = perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: perMinute, at: t };
    const tokens = Math.min(perMinute, b.tokens + (t - b.at) * refill);
    // Bounded: drop the least recently used member (re-inserting keeps Map order = recency).
    this.buckets.delete(key);
    if (this.buckets.size >= 10_000) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: t });
      return Math.max(1, Math.ceil((1 - tokens) / refill / 1000));
    }
    this.buckets.set(key, { tokens: tokens - 1, at: t });
    return 0;
  }

  invalidateTeam(teamId: string): void {
    this.states.deleteWhere((key) => key.startsWith(`${teamId}:`));
  }

  invalidateAll(): void {
    this.states.clear();
  }
}

import { exhaustedLine, type BudgetLine, type MemberBudgetState, type ModelPrice } from "@kobe/db";
import { randomUUID } from "node:crypto";
import { TtlCache } from "./cache.js";
import { MemoryReservations } from "./reservations-memory.js";
import { MEMBER_SHARE, type Cost, type ReservationStore } from "./reservations.js";
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
 *   cannot together overshoot a budget on one shim replica by more than the last admitted
 *   call. Reservations live in a {@link ReservationStore}: Postgres in production (KOBE-120:
 *   shared by all replicas, atomic against the budget, each with an expiry so a crashed
 *   replica's reservations free themselves), memory for tests.
 * - More requests than the member's per-minute rate (the install's, or the team's lower one): 429
 *   `rate_limited` with Retry-After. A token bucket per member per shim replica; Bifrost's
 *   virtual-key rate limit is the install-wide backstop.
 */
export interface BudgetStore {
  load(teamId: string, userId: string): Promise<MemberBudgetState>;
  /** Catalog prices by gateway model (cached by the gate). */
  prices(): Promise<ReadonlyMap<string, ModelPrice>>;
}

export { MEMBER_SHARE };
/** A reservation whose ledger row never lands (lost write) ends after this long. */
export const SETTLE_TIMEOUT_MS = 30_000;

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
  private readonly reservations: ReservationStore;
  private readonly onError: (err: unknown) => void;
  private readonly priceCache: TtlCache<ReadonlyMap<string, ModelPrice>>;
  private readonly now: () => number;

  constructor(
    private readonly store: BudgetStore,
    options: {
      readonly ttlMs: number;
      readonly now?: () => number;
      readonly maxEntries?: number;
      /** Where reservations live; default: this process's memory (tests, no shared state). */
      readonly reservations?: ReservationStore;
      /** A reservation could not be ended (it then expires on its own). */
      readonly onError?: (err: unknown) => void;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.reservations = options.reservations ?? new MemoryReservations();
    this.onError = options.onError ?? (() => undefined);
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
    const prices =
      state.lines.length === 0
        ? new Map<string, ModelPrice>()
        : await this.priceCache.get("prices", () => this.store.prices());
    return this.decide(call, key, state, prices);
  }

  private async decide(
    call: CallContext,
    key: string,
    state: MemberBudgetState,
    prices: ReadonlyMap<string, ModelPrice>,
  ): Promise<GateDecision> {
    const used = exhaustedLine(state.lines);
    if (used) {
      return { ok: false, status: 402, code: "budget_exhausted", message: budgetMessage(used) };
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
    const callId = call.callId ?? randomUUID();
    let verdict;
    try {
      // One atomic check-and-hold against the reservations of every replica.
      verdict = await this.reservations.reserve({
        teamId: call.teamId,
        userId: call.userId,
        callId,
        cost: this.costOf(call, prices),
        lines: state.lines,
      });
    } catch (err) {
      // Fail closed: without the reservations an overspend cannot be ruled out.
      this.onError(err);
      this.giveBack(key);
      return {
        ok: false,
        status: 503,
        code: "budget_unavailable",
        message: "The budget check is unavailable; retry shortly.",
        retryAfterSeconds: 2,
      };
    }
    if (!verdict.ok) {
      this.giveBack(key);
      if (verdict.verdict === "own_share") {
        return {
          ok: false,
          status: 429,
          code: "too_many_calls_in_flight",
          message: "Too many large model calls are in flight for this user; retry shortly.",
          retryAfterSeconds: 2,
        };
      }
      const l = state.lines[verdict.line] ?? state.lines[0];
      return {
        ok: false,
        status: 402,
        code: "budget_exhausted",
        message: l ? budgetMessage(l) : "A budget is used up.",
      };
    }
    return { ok: true, release: this.releaser(call, callId) };
  }

  private costOf(call: CallContext, prices: ReadonlyMap<string, ModelPrice>): Cost {
    const input = call.inputEstimate ?? 0;
    const output = call.outputAllowance ?? chargedOutput(undefined);
    const price = call.model ? prices.get(call.model) : undefined;
    return {
      tokens: input + output,
      usd: price ? (input * price.input + output * price.output) / 1_000_000 : 0,
    };
  }

  /**
   * The release of one reservation. `written`: the call's ledger row is on its way, so the
   * reservation stays until {@link settle} (the row landed and the cached spend was dropped, so
   * the next check sees it), or {@link SETTLE_TIMEOUT_MS} at most; otherwise it ends now. A
   * failure to end it is only logged: the reservation then expires by itself.
   */
  private releaser(call: CallContext, callId: string): (written: boolean) => void {
    return (written) => {
      const keep = written && call.callId ? SETTLE_TIMEOUT_MS : undefined;
      this.reservations.end(call.teamId, [callId], keep).catch(this.onError);
    };
  }

  /** The ledger rows of these calls were written: their reservations end (cache dropped first). */
  settle(teamId: string, callIds: readonly string[]): void {
    this.reservations.end(teamId, callIds).catch(this.onError);
  }

  private giveBack(key: string): void {
    const b = this.buckets.get(key);
    if (b) this.buckets.set(key, { ...b, tokens: b.tokens + 1 });
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

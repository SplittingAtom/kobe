import { exhaustedLine, type BudgetLine, type MemberBudgetState, type ModelPrice } from "@kobe/db";
import { randomUUID } from "node:crypto";
import { TtlCache } from "./cache.js";
import { MemoryReservations } from "./reservations-memory.js";
import {
  MEMBER_SHARE,
  type Cost,
  type ReservationStore,
  type ReserveVerdict,
} from "./reservations.js";
import { chargedOutput } from "./usage/charge.js";
import type { CallContext, CallGate, GateDecision } from "./seams.js";

/**
 * Kobe's own enforcement of budgets and per-user rate limits (KOBE-42, D30), at the identities the
 * session token proves: site, team and user (never the advisory run id, KOBE-41). A call is
 * refused **before** it reaches Bifrost; a call already forwarded is never cut, so the step in
 * flight finishes. The server's budget monitor then ends the runs (`stopForBudget`).
 *
 * - A used-up budget, in dollars or in tokens (spend ≥ limit for the month or the day, at any
 *   level; token budgets also cap models without catalog prices): 402
 *   `budget_exhausted`. Spend is what the `run_usage` ledger holds (written within about a second
 *   of a call ending); the state is cached for `ttlMs` and dropped on `spend:` / `budgets:` hints.
 * - **In-flight reservations** (KOBE-42 review): an admitted call reserves what it may cost (its
 *   input estimate plus the output it allows, `usage/charge.ts`; dollars at the catalog price) at
 *   its site, team and member levels until it ends, and a call is refused when spend plus the
 *   others' reservations reach a budget. Concurrent calls (many sandboxes of one team) therefore
 *   cannot together overshoot a budget on one shim replica by more than the last admitted
 *   call. Reservations live in a {@link ReservationStore}: Postgres in production (KOBE-120:
 *   shared by all replicas, atomic against the budget, each with an expiry so a crashed
 *   replica's reservations free themselves), memory for tests. Across replicas the bound
 *   holds for a check that ends within `settleHoldMs` of its spend read; a later one is
 *   repeated on a fresh read (KOBE-278).
 * - **A request larger than the whole budget** (KOBE-259): a call whose input estimate alone (with
 *   no output at all) exceeds a budget's limit itself (not what is left) could never fit, so it is
 *   refused at once, alone or not, with a final 402 `budget_below_call`. A budget below one call's
 *   output allowance is fine: the rules above apply unchanged (a lone call is admitted and may
 *   overshoot, overlapping calls wait).
 * - More requests than the member's per-minute rate (the site's, or the team's lower one): 429
 *   `rate_limited` with Retry-After. A token bucket per member per shim replica; Bifrost's
 *   virtual-key rate limit is the site-wide backstop.
 */
export interface BudgetStore {
  load(teamId: string, userId: string): Promise<MemberBudgetState>;
  /** Catalog prices by gateway model (cached by the gate). */
  prices(): Promise<ReadonlyMap<string, ModelPrice>>;
}

export { MEMBER_SHARE };
/** A reservation whose ledger row never lands (lost write) ends after this long. */
export const SETTLE_TIMEOUT_MS = 30_000;
/**
 * How much longer than the budget cache TTL production keeps a settled hold (KOBE-278): a check
 * may then land this late after its cached spend read (pool or advisory-lock queue under load)
 * and still be proven without a fresh read.
 */
export const SETTLE_HOLD_SLACK_MS = 2_000;

const SCOPE_NAMES: Readonly<Record<BudgetLine["scope"], string>> = {
  site: "The site's",
  team: "Your team's",
  user: "Your",
};

function budgetName(line: BudgetLine): string {
  const kind = line.unit === "tokens" ? "token" : "model";
  return `${SCOPE_NAMES[line.scope]} ${line.period === "month" ? "monthly" : "daily"} ${kind} budget`;
}

export function budgetMessage(line: BudgetLine): string {
  return `${budgetName(line)} is used up.`;
}

/** KOBE-259: the request's input alone exceeds the budget's limit; waiting cannot help. */
export function budgetBelowCallMessage(line: BudgetLine): string {
  const name = budgetName(line);
  return `This request's input is larger than ${name.charAt(0).toLowerCase()}${name.slice(1)} in total. Ask an admin to raise the budget, or start a new conversation with less context.`;
}

interface Bucket {
  tokens: number;
  at: number;
}

/** A member's budget state and when (gate clock) the gate began reading it. */
interface Snapshot {
  readonly state: MemberBudgetState;
  readonly readFrom: number;
}

/** A check-and-hold's answer, against the lines it was checked with. */
type Held =
  | { readonly verdict: ReserveVerdict; readonly lines: readonly BudgetLine[] }
  /** Two checks in a row ended too long after their spend reads to prove anything. */
  | "unproven";

const UNAVAILABLE: GateDecision = {
  ok: false,
  status: 503,
  code: "budget_unavailable",
  message: "The budget check is unavailable; retry shortly.",
  retryAfterSeconds: 2,
};

export class BudgetGate implements CallGate {
  private readonly states: TtlCache<Snapshot>;
  private readonly buckets = new Map<string, Bucket>();
  private readonly reservations: ReservationStore;
  private readonly onError: (err: unknown) => void;
  private readonly settleHoldMs: number;
  private readonly heartbeatMs: number | undefined;
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
      /**
       * How long a settled reservation keeps counting (KOBE-120): the other replicas' cached
       * spend may not show the call's cost yet. Default 0 (ended at once); production passes
       * the budget cache TTL. A check whose spend read is older than this when it ends is made
       * again against a fresh read (KOBE-278).
       */
      readonly settleHoldMs?: number;
      /** Extend the reservations of calls still running this often (a TTL/2 heartbeat). */
      readonly heartbeatMs?: number;
      /** A reservation could not be ended (it then expires on its own). */
      readonly onError?: (err: unknown) => void;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.reservations = options.reservations ?? new MemoryReservations();
    this.onError = options.onError ?? (() => undefined);
    this.settleHoldMs = options.settleHoldMs ?? 0;
    this.heartbeatMs = options.heartbeatMs;
    this.states = new TtlCache<Snapshot>({
      ttlMs: options.ttlMs,
      now: this.now,
      ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
    });
    this.priceCache = new TtlCache({ ttlMs: Math.max(options.ttlMs, 5_000), now: this.now });
  }

  async admit(call: CallContext): Promise<GateDecision> {
    const key = `${call.teamId}:${call.userId}`;
    const snap = await this.snapshot(call, key);
    const prices =
      snap.state.lines.length === 0
        ? new Map<string, ModelPrice>()
        : await this.priceCache.get("prices", () => this.store.prices());
    return this.decide(call, key, snap, prices);
  }

  /** The member's state, cached; `fresh` reads it again whatever the cache holds. */
  private snapshot(call: CallContext, key: string, fresh = false): Promise<Snapshot> {
    const load = async (): Promise<Snapshot> => {
      const readFrom = this.now();
      return { readFrom, state: await this.store.load(call.teamId, call.userId) };
    };
    return this.states.get(key, load, fresh);
  }

  private async decide(
    call: CallContext,
    key: string,
    snap: Snapshot,
    prices: ReadonlyMap<string, ModelPrice>,
  ): Promise<GateDecision> {
    const { state } = snap;
    const used = exhaustedLine(state.lines);
    if (used) {
      return { ok: false, status: 402, code: "budget_exhausted", message: budgetMessage(used) };
    }
    const input = this.inputCostOf(call, prices);
    const below = state.lines.find((l) => input[l.unit] > l.limit);
    if (below) {
      return {
        ok: false,
        status: 402,
        code: "budget_below_call",
        message: budgetBelowCallMessage(below),
      };
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
    let held: Held;
    try {
      held = await this.hold(call, key, callId, snap, prices);
    } catch (err) {
      // Fail closed: without the reservations an overspend cannot be ruled out.
      this.onError(err);
      this.giveBack(key);
      return UNAVAILABLE;
    }
    if (held === "unproven") {
      this.giveBack(key);
      return UNAVAILABLE;
    }
    const { verdict, lines } = held;
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
      const l = lines[verdict.line] ?? lines[0];
      return {
        ok: false,
        status: 402,
        code: "budget_exhausted",
        message: l ? budgetMessage(l) : "A budget is used up.",
      };
    }
    return { ok: true, release: this.releaser(call, callId) };
  }

  /**
   * One atomic check-and-hold against the reservations of every replica (KOBE-120). Calls
   * written after the spend read count only through their settled holds, which last
   * `settleHoldMs` from their settle, so a check proves the budget only if it ended within
   * `settleHoldMs` of the read (KOBE-278). One that may have run later (an old cache entry plus a
   * slow pool or advisory-lock queue under load) is ended and made once more against a fresh
   * read; if that one is slow too, the call is refused (fail closed).
   */
  private async hold(
    call: CallContext,
    key: string,
    callId: string,
    snap: Snapshot,
    prices: ReadonlyMap<string, ModelPrice>,
  ): Promise<Held> {
    const first = await this.reserveOn(call, callId, snap.state.lines, prices);
    if (!first.ok || this.proven(snap)) return { verdict: first, lines: snap.state.lines };
    await this.reservations.end(call.teamId, [callId]);
    const fresh = await this.snapshot(call, key, true);
    const { lines } = fresh.state;
    const used = exhaustedLine(lines);
    if (used) return { verdict: { ok: false, verdict: "full", line: lines.indexOf(used) }, lines };
    const again = await this.reserveOn(call, callId, lines, prices);
    if (!again.ok || this.proven(fresh)) return { verdict: again, lines };
    await this.reservations.end(call.teamId, [callId]);
    return "unproven";
  }

  private reserveOn(
    call: CallContext,
    callId: string,
    lines: readonly BudgetLine[],
    prices: ReadonlyMap<string, ModelPrice>,
  ): Promise<ReserveVerdict> {
    return this.reservations.reserve({
      teamId: call.teamId,
      userId: call.userId,
      callId,
      cost: this.costOf(call, prices),
      lines,
    });
  }

  /** The check ended within `settleHoldMs` of the read (without settled holds: nothing to prove). */
  private proven(snap: Snapshot): boolean {
    return this.settleHoldMs <= 0 || this.now() - snap.readFrom < this.settleHoldMs;
  }

  /** The call's input alone, at no output (KOBE-259 `budget_below_call`). */
  private inputCostOf(call: CallContext, prices: ReadonlyMap<string, ModelPrice>): Cost {
    const input = call.inputEstimate ?? 0;
    const price = call.model ? prices.get(call.model) : undefined;
    return { tokens: input, usd: price ? (input * price.input) / 1_000_000 : 0 };
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
    // A call still running keeps its reservation alive (no expiry while it streams).
    const beat =
      this.heartbeatMs === undefined
        ? undefined
        : setInterval(() => {
            this.reservations.extend(call.teamId, [callId]).catch(this.onError);
          }, this.heartbeatMs);
    beat?.unref();
    return (written) => {
      if (beat) clearInterval(beat);
      const keep = written && call.callId ? SETTLE_TIMEOUT_MS : undefined;
      this.reservations.end(call.teamId, [callId], keep).catch(this.onError);
    };
  }

  /**
   * The ledger rows of these calls were written: their reservations end, after
   * `settleHoldMs`, so that replicas whose cached spend predates the rows still count them.
   */
  settle(teamId: string, callIds: readonly string[]): void {
    const hold = this.settleHoldMs > 0 ? this.settleHoldMs : undefined;
    this.reservations.end(teamId, callIds, hold).catch(this.onError);
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

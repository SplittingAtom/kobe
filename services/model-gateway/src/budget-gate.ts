import {
  exhaustedLine,
  scaledDecimal,
  thresholdReached,
  type BudgetLine,
  type MemberBudgetState,
  type ModelPrice,
} from "@kobe/db";
import { SERVER_CALL_LIMITS, type ServerCallTokenPurpose } from "@kobe/protocol";
import { randomUUID } from "node:crypto";
import { TtlCache } from "./cache.js";
import { MemoryReservations } from "./reservations-memory.js";
import { MEMBER_SHARE, type Cost, type ReservationStore } from "./reservations.js";
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
 *   replica's reservations free themselves), memory for tests. In Postgres the check reads
 *   each line's spend itself, in one snapshot with the reservations (KOBE-286), so the cached
 *   spend below only refuses early; it never admits a call the database would refuse.
 * - **A request larger than the whole budget** (KOBE-259): a call whose input estimate alone (with
 *   no output at all) exceeds a budget's limit itself (not what is left) could never fit, so it is
 *   refused at once, alone or not, with a final 402 `budget_below_call`. A budget below one call's
 *   output allowance is fine: the rules above apply unchanged (a lone call is admitted and may
 *   overshoot, overlapping calls wait).
 * - **Server calls** (KOBE-234): the same lines and reservations, plus the purpose's soft limit
 *   (`SERVER_CALL_LIMITS[purpose].skip_at_percent`): follow-ups are refused with a final 402
 *   `budget_soft_limit` once any line is at 80 %, so a server bug cannot spend past CE21's rule.
 * - **The team eval cap** (KOBE-327, SK18): a skill eval's calls (its eval sandbox's and the eval
 *   judge's) also carry the team's monthly eval cap as a line of scope `eval`, judged in the same
 *   reservation on the team's eval spend and the other eval calls' reservations: 402
 *   `budget_exhausted` "Your team's monthly eval cap is used up." Other calls never see it.
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

const SCOPE_NAMES: Readonly<Record<BudgetLine["scope"], string>> = {
  site: "The site's",
  team: "Your team's",
  user: "Your",
  eval: "Your team's",
};

function budgetName(line: BudgetLine): string {
  if (line.scope === "eval") return "Your team's monthly eval cap";
  const kind = line.unit === "tokens" ? "token" : "model";
  return `${SCOPE_NAMES[line.scope]} ${line.period === "month" ? "monthly" : "daily"} ${kind} budget`;
}

/**
 * The lines a call is judged by: the member's budgets, and for a skill eval's call (its eval
 * sandbox's, or the eval judge's) the team eval cap too (KOBE-327, SK18).
 */
function linesFor(call: CallContext, state: MemberBudgetState): readonly BudgetLine[] {
  const evalCall = call.eval === true || call.purpose === "eval_judge";
  return evalCall && state.evalLines?.length ? [...state.lines, ...state.evalLines] : state.lines;
}

export function budgetMessage(line: BudgetLine): string {
  return `${budgetName(line)} is used up.`;
}

const SKIPPED: Record<ServerCallTokenPurpose, string> = {
  title: "titles",
  followups: "follow-ups",
  eval_judge: "eval judge calls",
};

/** KOBE-234: a server call skipped at its purpose's soft limit (follow-ups at 80 %). */
export function budgetSoftLimitMessage(line: BudgetLine, purpose: ServerCallTokenPurpose): string {
  const pct = SERVER_CALL_LIMITS[purpose].skip_at_percent;
  return `${budgetName(line)} is at ${pct} % or more: ${SKIPPED[purpose]} are skipped.`;
}

/** The purpose's soft limit in percent, when it is below the 100 % stop. */
function softPercent(purpose: ServerCallTokenPurpose | undefined): number | undefined {
  if (purpose === undefined) return undefined;
  const pct = SERVER_CALL_LIMITS[purpose].skip_at_percent;
  return pct < 100 ? pct : undefined;
}

const SCALE = 10n ** 12n;

/** A count of 1e-12 units as plain decimal text (the inverse of `scaledDecimal`). */
function decimalText(units: bigint): string {
  const sign = units < 0n ? "-" : "";
  const abs = units < 0n ? -units : units;
  return `${sign}${abs / SCALE}.${(abs % SCALE).toString().padStart(12, "0")}`;
}

/**
 * The line with its limit at `pct` %: what the reservation judges a soft-limited server call by,
 * so the 80 % rule uses the database's own spend read and the other calls' reservations
 * (KOBE-286), not this replica's cached spend (review L2).
 */
function atPercent(line: BudgetLine, pct: number): BudgetLine {
  const { limitExact, ...rest } = line;
  return {
    ...rest,
    limit: (line.limit * pct) / 100,
    ...(limitExact === undefined
      ? {}
      : { limitExact: decimalText((scaledDecimal(limitExact) * BigInt(pct)) / 100n) }),
  };
}

/** The first line at or past a server call's soft limit (none below 100 %: the stop applies). */
function softLimitLine(
  lines: readonly BudgetLine[],
  purpose: ServerCallTokenPurpose | undefined,
): BudgetLine | undefined {
  const pct = softPercent(purpose);
  return pct === undefined ? undefined : lines.find((l) => thresholdReached(l, pct));
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

export class BudgetGate implements CallGate {
  private readonly states: TtlCache<MemberBudgetState>;
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
       * How long a settled reservation keeps counting. Default 0 (ended at once), as production
       * runs: the database check reads the spend itself (KOBE-286), so a written call counts
       * there and a longer hold would only count it twice. Only for stores judged on the
       * caller's spend.
       */
      readonly settleHoldMs?: number;
      /** Extend the reservations of calls still running this often (a TTL/2 heartbeat). */
      readonly heartbeatMs?: number;
      /** A reservation call failed: a reserve (then 503) or an end (it then expires by itself). */
      readonly onError?: (err: unknown) => void;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.reservations = options.reservations ?? new MemoryReservations();
    this.onError = options.onError ?? (() => undefined);
    this.settleHoldMs = options.settleHoldMs ?? 0;
    this.heartbeatMs = options.heartbeatMs;
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
      state.lines.length === 0 && !state.evalLines?.length
        ? new Map<string, ModelPrice>()
        : await this.priceCache.get("prices", () => this.store.prices());
    return this.decide(call, key, state, prices);
  }

  private async decide(
    call: CallContext,
    key: string,
    member: MemberBudgetState,
    prices: ReadonlyMap<string, ModelPrice>,
  ): Promise<GateDecision> {
    const state = { ...member, lines: linesFor(call, member) };
    const used = exhaustedLine(state.lines);
    if (used) {
      return { ok: false, status: 402, code: "budget_exhausted", message: budgetMessage(used) };
    }
    const soft = softLimitLine(state.lines, call.purpose);
    if (soft && call.purpose) {
      return {
        ok: false,
        status: 402,
        code: "budget_soft_limit",
        message: budgetSoftLimitMessage(soft, call.purpose),
      };
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
    // A soft-limited server call is judged against its percentage of every line, in the database
    // (the cached check above only refuses early).
    const pct = softPercent(call.purpose);
    const judged = pct === undefined ? state.lines : state.lines.map((l) => atPercent(l, pct));
    let verdict;
    try {
      // One atomic check-and-hold against the reservations of every replica.
      verdict = await this.reservations.reserve({
        teamId: call.teamId,
        userId: call.userId,
        callId,
        cost: this.costOf(call, prices),
        lines: judged,
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
      if (pct !== undefined && call.purpose && l) {
        return {
          ok: false,
          status: 402,
          code: "budget_soft_limit",
          message: budgetSoftLimitMessage(l, call.purpose),
        };
      }
      return {
        ok: false,
        status: 402,
        code: "budget_exhausted",
        message: l ? budgetMessage(l) : "A budget is used up.",
      };
    }
    return { ok: true, release: this.releaser(call, callId) };
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
   * reservation is renewed for a full reservation TTL and stays until {@link settle} ends it
   * once the row landed (cut short, a row landing late would count nowhere; counted twice
   * meanwhile is harmless, KOBE-286); otherwise it ends now. A failure is only logged: the
   * reservation then expires by itself.
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
      if (written && call.callId) {
        this.reservations.extend(call.teamId, [callId]).catch(this.onError);
      } else {
        this.reservations.end(call.teamId, [callId]).catch(this.onError);
      }
    };
  }

  /**
   * The ledger rows of these calls were written: their reservations end (after `settleHoldMs`,
   * 0 in production: the database check now sees the rows' spend instead, KOBE-286).
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

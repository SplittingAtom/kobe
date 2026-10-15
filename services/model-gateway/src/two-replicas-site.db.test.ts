import { randomUUID } from "node:crypto";
import { createDb, sql, teams, type BudgetLine, type KobeDatabase } from "@kobe/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { BudgetGate } from "./budget-gate.js";
import { DbReservations } from "./reservations-db.js";
import type { ReserveRequest, ReserveVerdict } from "./reservations.js";
import type { CallContext, GateDecision } from "./seams.js";

/**
 * KOBE-121 (ac-1) at the gate level: two gate instances ("replicas", each with its own pool and
 * spend cache) share one Postgres and one site-wide token budget across several teams. The
 * ledger is simulated and never pushed to the gates (no spend hints): each gate only learns of the
 * spend when its cache expires, so the settled holds alone must cover that window. Also: a
 * crashed replica's holds expire and free the budget, and leave no live row behind.
 *
 * KOBE-278 / KOBE-261: no wall-clock races. Every fire-and-forget release and settle is tracked
 * and awaited, expiries are waited for on the database clock (bounded polls), and the load test
 * runs until the budget is used up rather than for a fixed time. A slow check (one that lands
 * after the settled holds of calls written since its spend read have ended) is reproduced
 * step by step.
 */
const CALL = 100;
const ALLOWED = 20;
const LIMIT = ALLOWED * CALL + CALL / 2;
const CACHE_TTL_MS = 300;
/** Cache TTL plus slack, as production adds `SETTLE_HOLD_SLACK_MS` (smaller here, to stay quick). */
const SETTLE_HOLD_MS = 2 * CACHE_TTL_MS;
/** Safety cap for loops and polls: far above what they need, only to fail instead of hanging. */
const CAP_MS = 20_000;
const salt = "two-replica-test-salt";
const teamIds = [randomUUID(), randomUUID(), randomUUID()];

let owner: KobeDatabase;
const dbs: KobeDatabase[] = [];

/** The simulated ledger: tokens already written for the install. */
const ledger = { spent: 0 };
const siteLine = (): BudgetLine => ({
  scope: "site",
  userId: undefined,
  period: "day",
  periodStart: "2026-10-10",
  unit: "tokens",
  limit: LIMIT,
  spent: ledger.spent,
});
const member = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const call = (teamId: string, userId: string): CallContext => ({
  teamId,
  userId,
  sandboxId: randomUUID(),
  runId: undefined,
  route: "openai",
  path: "/v1/chat/completions",
  model: undefined,
  inputEstimate: CALL - 20,
  outputAllowance: 20,
  callId: randomUUID(),
});

/**
 * Tracks every end() (the gate's release and settle are fire-and-forget) so a test can wait for
 * them; `park()` holds each reserve before it reaches the database until `unpark()`.
 */
class TrackedReservations extends DbReservations {
  private readonly pending = new Set<Promise<void>>();
  private parked: Promise<void> | undefined;
  private unparkAll: (() => void) | undefined;
  waiting = 0;
  override end(teamId: string, callIds: readonly string[], keepMs?: number): Promise<void> {
    const p = super.end(teamId, callIds, keepMs);
    this.pending.add(p);
    return p.finally(() => this.pending.delete(p));
  }
  override async reserve(r: ReserveRequest): Promise<ReserveVerdict> {
    if (this.parked) {
      this.waiting++;
      await this.parked;
    }
    return super.reserve(r);
  }
  park(): void {
    this.parked = new Promise((resolve) => (this.unparkAll = resolve));
  }
  unpark(): void {
    this.parked = undefined;
    this.unparkAll?.();
  }
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}

const replica = (reservationTtlMs: number) => {
  const app = createDb(inject("appUrl"), { max: 4 });
  dbs.push(app);
  const reservations = new TrackedReservations(app.db, { ttlMs: reservationTtlMs, salt });
  const gate = new BudgetGate(
    {
      load: async () => ({ lines: [siteLine()], requestsPerMinute: 10_000 }),
      prices: async () => new Map(),
    },
    { ttlMs: CACHE_TTL_MS, reservations, settleHoldMs: SETTLE_HOLD_MS },
  );
  return { gate, reservations };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const liveHolds = async () => {
  const r = await owner.db.execute<{ n: string }>(
    sql`SELECT count(*) AS n FROM site_budget_reservations WHERE expires_at > clock_timestamp()`,
  );
  return Number(r.rows[0]?.n ?? 0);
};
/** Waits (bounded) until no hold is live on the database clock. */
const noLiveHolds = async () => {
  const end = Date.now() + CAP_MS;
  while ((await liveHolds()) > 0) {
    if (Date.now() > end) throw new Error("holds still live after the cap");
    await sleep(50);
  }
};
/**
 * Admits `n` calls one after another. The budget leaves room for all of them; the only refusal
 * allowed is a check slowed past the settle hold twice by a loaded machine (503, fail closed,
 * KOBE-278), which is retried.
 */
const untilAdmitted = async (n: number, admit: (i: number) => Promise<GateDecision>) => {
  const end = Date.now() + CAP_MS;
  let admitted = 0;
  for (let i = 0; admitted < n; i++) {
    if (Date.now() > end) throw new Error(`only ${admitted} of ${n} admitted before the cap`);
    const d = await admit(i);
    if (d.ok) admitted++;
    else expect(d.code).toBe("budget_unavailable");
  }
};
/** Writes an admitted call's ledger row and ends it as the sink does: release, then settle. */
const finish = (gate: BudgetGate, ctx: CallContext, d: GateDecision) => {
  ledger.spent += CALL; // the usage row lands
  if (d.ok) d.release?.(true);
  gate.settle(ctx.teamId, [ctx.callId ?? ""]);
};

beforeAll(async () => {
  owner = createDb(inject("ownerUrl"));
  await owner.db
    .insert(teams)
    .values(teamIds.map((id) => ({ id, slug: `ir-${id.slice(0, 8)}`, name: "I" })));
});
afterAll(async () => {
  await Promise.all([...dbs, owner].map((d) => d.close()));
});

describe("two gate replicas, one site-wide hard budget (KOBE-121 ac-1)", () => {
  it("calls over time on both replicas, with stale caches, overshoot by at most one call", async () => {
    ledger.spent = 0;
    const replicas = [replica(60_000), replica(60_000)];
    let admitted = 0;
    // Runs until the budget is used up, then until every settled hold has ended and every cache
    // has gone stale at least once more, however slow the machine is.
    let usedUpAt: number | undefined;
    const started = Date.now();
    const running = () => {
      const t = Date.now();
      if (t - started > CAP_MS) return false;
      if (usedUpAt === undefined && ledger.spent >= LIMIT) usedUpAt = t;
      return usedUpAt === undefined || t - usedUpAt < SETTLE_HOLD_MS + 2 * CACHE_TTL_MS;
    };
    // 40 members over 3 teams, half on each replica, each making calls back to back.
    const worker = async (i: number) => {
      const gate = replicas[i % 2]?.gate;
      if (!gate) throw new Error("no replica");
      while (running()) {
        const ctx = call(teamIds[i % 3] ?? "", member(i));
        const d = await gate.admit(ctx);
        if (!d.ok) {
          await sleep(20);
          continue;
        }
        admitted++;
        await sleep(15);
        finish(gate, ctx, d);
        await sleep(5);
      }
    };
    await Promise.all(Array.from({ length: 40 }, (_, i) => worker(i)));
    await Promise.all(replicas.map((r) => r.reservations.idle()));
    const overshoot = Math.max(0, ledger.spent - LIMIT);
    console.info(
      `KOBE-121 site line: limit ${LIMIT}, one call ${CALL}, admitted ${admitted}, spent ${ledger.spent}, overshoot ${overshoot}`,
    );
    expect(usedUpAt).toBeDefined();
    expect(ledger.spent).toBe(admitted * CALL);
    expect(overshoot).toBeLessThanOrEqual(CALL);
    expect(admitted).toBeGreaterThanOrEqual(ALLOWED);
    await noLiveHolds();
  });

  it("a check that lands after the settled holds ended does not admit on the stale spend (KOBE-278)", async () => {
    await noLiveHolds();
    ledger.spent = 0;
    const a = replica(60_000);
    const b = replica(60_000);
    // B reads the spend (0) for four members, then each check waits in a queue (pool, lock).
    b.reservations.park();
    const late = Array.from({ length: 4 }, (_, i) => {
      const ctx = call(teamIds[i % 3] ?? "", member(100 + i));
      return b.gate.admit(ctx);
    });
    while (b.reservations.waiting < late.length) await sleep(5);
    // Meanwhile A uses up the budget; the rows land and settle slowly, after the cache TTL.
    const done: [CallContext, GateDecision][] = [];
    await untilAdmitted(ALLOWED + 1, async (i) => {
      const ctx = call(teamIds[i % 3] ?? "", member(200 + i));
      const d = await a.gate.admit(ctx);
      if (d.ok) done.push([ctx, d]);
      return d;
    });
    await sleep(SETTLE_HOLD_MS);
    for (const [ctx, d] of done) finish(a.gate, ctx, d);
    await a.reservations.idle();
    // A's settled holds end (database clock); B's spend read predates every one of those rows.
    await noLiveHolds();
    b.reservations.unpark();
    const decisions = await Promise.all(late);
    // Free any late admit before asserting, so a failure here leaves no hold to later tests.
    for (const d of decisions) if (d.ok) d.release?.(false);
    await b.reservations.idle();
    const admittedLate = decisions.filter((d) => d.ok).length;
    ledger.spent += admittedLate * CALL;
    const overshoot = Math.max(0, ledger.spent - LIMIT);
    console.info(`KOBE-278 slow check: admitted late ${admittedLate}, overshoot ${overshoot}`);
    expect(overshoot).toBeLessThanOrEqual(CALL);
    expect(decisions.every((d) => !d.ok && d.code === "budget_exhausted")).toBe(true);
    expect(await liveHolds()).toBe(0);
  });

  it("a crashed replica's holds free the budget by themselves and leave no live row", async () => {
    const CRASH_TTL_MS = 3_000;
    const healthy = replica(60_000);
    // The crashing replica takes the whole budget (20 calls and a half) and then dies. Its holds
    // are certainly all live at the healthy replica's check only if that check ended within the
    // TTL of the first hold: a run slower than that proves nothing and is made again. The first
    // attempt is made that slow on purpose, so the retry path runs every time.
    let blocked: GateDecision | undefined;
    let attempts = 0;
    for (; attempts < 4 && blocked === undefined; attempts++) {
      // Wait out the previous tests' (or attempt's) holds.
      await noLiveHolds();
      ledger.spent = 0;
      const crashing = replica(CRASH_TTL_MS);
      const started = Date.now();
      await untilAdmitted(ALLOWED + 1, (i) =>
        crashing.gate.admit(call(teamIds[i % 3] ?? "", randomUUID())),
      );
      if (attempts === 0) await sleep(CRASH_TTL_MS);
      const d = await healthy.gate.admit(call(teamIds[0] ?? "", randomUUID()));
      // A 503 (a check slowed past the hold twice, KOBE-278) is not the refusal under test.
      const inTime = Date.now() - started < CRASH_TTL_MS;
      if (inTime && (d.ok || d.code !== "budget_unavailable")) {
        blocked = d;
      } else if (d.ok) {
        // Inconclusive and admitted: free its hold so the next attempt starts clean.
        d.release?.(false);
        await healthy.reservations.idle();
      }
    }
    expect(attempts).toBeGreaterThan(1);
    expect(blocked).toMatchObject({ ok: false, code: "budget_exhausted" });
    // The holds expire by themselves (database clock), then the budget is free again.
    await noLiveHolds();
    const again = await healthy.gate.admit(call(teamIds[0] ?? "", randomUUID()));
    expect(again.ok).toBe(true);
    if (again.ok) again.release?.(false);
    await healthy.reservations.idle();
    expect(await liveHolds()).toBe(0);
  });
});

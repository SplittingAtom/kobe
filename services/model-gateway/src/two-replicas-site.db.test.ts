import { randomUUID } from "node:crypto";
import {
  createDb,
  recordModelUsage,
  sql,
  teams,
  users,
  type BudgetLine,
  type KobeDatabase,
} from "@kobe/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { BudgetGate } from "./budget-gate.js";
import { DbReservations } from "./reservations-db.js";
import type { ReserveRequest, ReserveVerdict } from "./reservations.js";
import type { CallContext, GateDecision } from "./seams.js";

/**
 * KOBE-121 (ac-1) at the gate level: two gate instances ("replicas", each with its own pool and
 * spend cache) share one Postgres and one site-wide token budget across several teams. Ledger
 * rows are really written (the run_usage trigger keeps the counters) but never pushed to the
 * gates (no spend hints): each gate's cached spend goes stale for its TTL. Also: a crashed
 * replica's holds expire and free the budget, and leave no live row behind.
 *
 * KOBE-278 / KOBE-261: no wall-clock races. Every fire-and-forget release and settle is tracked
 * and awaited, expiries are waited for on the database clock (bounded polls), and the load test
 * runs until the budget is used up rather than for a fixed time. A check made on a spend read
 * that predates the calls that used the budget up is reproduced step by step.
 *
 * KOBE-286: the reservation reads the spend itself, so settled holds end at once, as in
 * production (no `settleHoldMs`), and a nearly used-up budget is not refused early.
 */
const CALL = 100;
const ALLOWED = 20;
/** The budget on top of what the site spent before each test (the counters are site-wide). */
const LIMIT = ALLOWED * CALL + CALL / 2;
const CACHE_TTL_MS = 300;
/** Safety cap for loops and polls: far above what they need, only to fail instead of hanging. */
const CAP_MS = 20_000;
const salt = "two-replica-test-salt";
const teamIds = [randomUUID(), randomUUID(), randomUUID()];
const member = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
/** Members that write ledger rows (run_usage needs the user). */
const MEMBERS = [
  ...Array.from({ length: 40 }, (_, i) => i),
  ...Array.from({ length: 30 }, (_, i) => 200 + i),
  ...Array.from({ length: 6 }, (_, i) => 300 + i),
];

let owner: KobeDatabase;
let writer: KobeDatabase;
const dbs: KobeDatabase[] = [];

/** The site's token spend this month, from the counters (database clock). */
const siteSpent = async () => {
  const r = await owner.db.execute<{ t: string }>(
    sql`SELECT COALESCE(sum(tokens), 0) AS t FROM site_model_spend_daily
         WHERE day >= date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date`,
  );
  return Number(r.rows[0]?.t ?? 0);
};
/** What the site had spent before the running test. */
const base = { spent: 0 };
const spentSinceStart = async () => (await siteSpent()) - base.spent;
const siteLine = (spent: number): BudgetLine => ({
  scope: "site",
  userId: undefined,
  period: "month",
  periodStart: "2026-10-01",
  unit: "tokens",
  limit: base.spent + LIMIT,
  spent,
});
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
 * Tracks every end() and extend() (the gate's release and settle are fire-and-forget) so a test can wait for
 * them; `park()` holds each reserve before it reaches the database until `unpark()`.
 */
class TrackedReservations extends DbReservations {
  private readonly pending = new Set<Promise<void>>();
  private parked: Promise<void> | undefined;
  private unparkAll: (() => void) | undefined;
  waiting = 0;
  private track(p: Promise<void>): Promise<void> {
    this.pending.add(p);
    return p.finally(() => this.pending.delete(p));
  }
  override end(teamId: string, callIds: readonly string[], keepMs?: number): Promise<void> {
    return this.track(super.end(teamId, callIds, keepMs));
  }
  override extend(teamId: string, callIds: readonly string[]): Promise<void> {
    return this.track(super.extend(teamId, callIds));
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

/** A replica as production wires it: the spend from the counters, cached; no settle hold. */
const replica = (reservationTtlMs: number) => {
  const app = createDb(inject("appUrl"), { max: 4 });
  dbs.push(app);
  const reservations = new TrackedReservations(app.db, { ttlMs: reservationTtlMs, salt });
  const gate = new BudgetGate(
    {
      load: async () => ({ lines: [siteLine(await siteSpent())], requestsPerMinute: 10_000 }),
      prices: async () => new Map(),
    },
    { ttlMs: CACHE_TTL_MS, reservations },
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
/** A fresh start: no live hold, and the budget counted from the site's spend now. */
const fresh = async () => {
  await noLiveHolds();
  base.spent = await siteSpent();
};
/** Admits `n` calls one after another; the budget leaves room for all of them. */
const admitAll = async (n: number, admit: (i: number) => Promise<GateDecision>) => {
  for (let i = 0; i < n; i++) expect((await admit(i)).ok).toBe(true);
};
/** Writes an admitted call's ledger row (one call's tokens), as the sink does. */
const write = (ctx: CallContext) =>
  recordModelUsage(writer.db, [
    {
      id: randomUUID(),
      teamId: ctx.teamId,
      userId: ctx.userId,
      sandboxId: ctx.sandboxId,
      runId: undefined,
      at: new Date(),
      route: "openai",
      model: "kobe-unpriced/m",
      status: 200,
      inputTokens: CALL - 20,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usageSource: "reported",
      durationMs: 1,
      ttfbMs: 1,
      aborted: false,
    },
  ]);
/** The call ended with its row on its way (release), the row landed, then it is settled. */
const finish = async (gate: BudgetGate, ctx: CallContext, d: GateDecision) => {
  if (d.ok) d.release?.(true);
  await write(ctx);
  gate.settle(ctx.teamId, [ctx.callId ?? ""]);
};

beforeAll(async () => {
  owner = createDb(inject("ownerUrl"));
  await owner.db
    .insert(teams)
    .values(teamIds.map((id) => ({ id, slug: `ir-${id.slice(0, 8)}`, name: "I" })));
  writer = createDb(inject("appUrl"), { max: 8 });
  await writer.db
    .insert(users)
    .values(MEMBERS.map((i) => ({ id: member(i), name: "M", email: `${member(i)}@ir.test` })));
});
afterAll(async () => {
  await Promise.all([...dbs, writer, owner].map((d) => d.close()));
});

describe("two gate replicas, one site-wide hard budget (KOBE-121 ac-1)", () => {
  it("calls over time on both replicas, with stale caches, overshoot by at most one call", async () => {
    await fresh();
    const replicas = [replica(60_000), replica(60_000)];
    let admitted = 0;
    let written = 0;
    // Runs until the budget is used up, then for two more cache lifetimes: every cache goes stale
    // while calls keep coming, however slow the machine is.
    let usedUpAt: number | undefined;
    const started = Date.now();
    const running = () => {
      const t = Date.now();
      if (t - started > CAP_MS) return false;
      if (usedUpAt === undefined && written * CALL >= LIMIT) usedUpAt = t;
      return usedUpAt === undefined || t - usedUpAt < 2 * CACHE_TTL_MS;
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
        await finish(gate, ctx, d);
        written++;
        await sleep(5);
      }
    };
    await Promise.all(Array.from({ length: 40 }, (_, i) => worker(i)));
    await Promise.all(replicas.map((r) => r.reservations.idle()));
    const spent = await spentSinceStart();
    const overshoot = Math.max(0, spent - LIMIT);
    console.info(
      `KOBE-121 site line: limit ${LIMIT}, one call ${CALL}, admitted ${admitted}, spent ${spent}, overshoot ${overshoot}`,
    );
    expect(usedUpAt).toBeDefined();
    expect(spent).toBe(admitted * CALL);
    expect(overshoot).toBeLessThanOrEqual(CALL);
    expect(admitted).toBeGreaterThanOrEqual(ALLOWED);
    await noLiveHolds();
  });

  it("a check made on a spend read older than the calls that used the budget up is refused (KOBE-278)", async () => {
    await fresh();
    const a = replica(60_000);
    const b = replica(60_000);
    // B reads the spend (nothing yet) for four members, then each check waits in a queue.
    b.reservations.park();
    const late = Array.from({ length: 4 }, (_, i) => {
      const ctx = call(teamIds[i % 3] ?? "", member(100 + i));
      return b.gate.admit(ctx);
    });
    while (b.reservations.waiting < late.length) await sleep(5);
    // Meanwhile A uses up the budget; the rows land and settle slowly, after the cache TTL.
    const done: [CallContext, GateDecision][] = [];
    await admitAll(ALLOWED + 1, async (i) => {
      const ctx = call(teamIds[i % 3] ?? "", member(200 + i));
      const d = await a.gate.admit(ctx);
      if (d.ok) done.push([ctx, d]);
      return d;
    });
    await sleep(CACHE_TTL_MS);
    for (const [ctx, d] of done) await finish(a.gate, ctx, d);
    await a.reservations.idle();
    // A's holds are gone; B's spend read predates every one of those rows.
    expect(await liveHolds()).toBe(0);
    b.reservations.unpark();
    const decisions = await Promise.all(late);
    // Free any late admit before asserting, so a failure here leaves no hold to later tests.
    for (const d of decisions) if (d.ok) d.release?.(false);
    await b.reservations.idle();
    const admittedLate = decisions.filter((d) => d.ok).length;
    const overshoot = Math.max(0, (await spentSinceStart()) + admittedLate * CALL - LIMIT);
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
      await fresh();
      const crashing = replica(CRASH_TTL_MS);
      const started = Date.now();
      await admitAll(ALLOWED + 1, (i) =>
        crashing.gate.admit(call(teamIds[i % 3] ?? "", randomUUID())),
      );
      if (attempts === 0) await sleep(CRASH_TTL_MS);
      const d = await healthy.gate.admit(call(teamIds[0] ?? "", randomUUID()));
      if (Date.now() - started < CRASH_TTL_MS) {
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

  it("a nearly used-up budget still admits a call: written calls count once (KOBE-286)", async () => {
    await fresh();
    const replicas = [replica(60_000), replica(60_000)] as const;
    // Five members on both replicas spend 20 calls (2000 of 2050), each written and settled.
    for (let round = 0; round < 4; round++) {
      for (let m = 0; m < 5; m++) {
        const r = replicas[m % 2] ?? replicas[0];
        const ctx = call(teamIds[m % 3] ?? "", member(300 + m));
        const d = await r.gate.admit(ctx);
        expect(d, `round ${round}, member ${m}`).toMatchObject({ ok: true });
        await finish(r.gate, ctx, d);
        await r.reservations.idle();
      }
    }
    expect(await spentSinceStart()).toBe(20 * CALL);
    // Nothing runs: 2000 of 2050 is spent, so one more call is admitted (and may overshoot by
    // at most itself). Settled holds still counting next to the spend would refuse it (402),
    // which the server turns into a run stopped for good.
    const last = call(teamIds[0] ?? "", member(305));
    const d = await replicas[1].gate.admit(last);
    expect(d).toMatchObject({ ok: true });
    await finish(replicas[1].gate, last, d);
    await Promise.all(replicas.map((r) => r.reservations.idle()));
    // And then the budget is used up.
    expect(await replicas[0].gate.admit(call(teamIds[1] ?? "", member(304)))).toMatchObject({
      ok: false,
      code: "budget_exhausted",
    });
  });
});

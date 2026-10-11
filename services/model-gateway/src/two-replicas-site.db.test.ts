import { randomUUID } from "node:crypto";
import { createDb, sql, teams, type BudgetLine, type KobeDatabase } from "@kobe/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { BudgetGate } from "./budget-gate.js";
import { DbReservations } from "./reservations-db.js";
import type { CallContext } from "./seams.js";

/**
 * KOBE-121 (ac-1) at the gate level: two gate instances ("replicas", each with its own pool and
 * spend cache) share one Postgres and one site-wide token budget across several teams. The
 * ledger is simulated and never pushed to the gates (no spend hints): each gate only learns of the
 * spend when its cache expires, so the settled holds alone must cover that window. Also: a
 * crashed replica's holds expire and free the budget, and leave no live row behind.
 */
const CALL = 100;
const ALLOWED = 20;
const LIMIT = ALLOWED * CALL + CALL / 2;
const CACHE_TTL_MS = 300;
const salt = "two-replica-test-salt";
const teamIds = [randomUUID(), randomUUID(), randomUUID()];

let owner: KobeDatabase;
const dbs: KobeDatabase[] = [];

/** The simulated ledger: tokens already written for the install. */
const ledger = { spent: 0 };
const siteLine = (): BudgetLine => ({
  scope: "install",
  userId: undefined,
  period: "day",
  periodStart: "2026-10-10",
  unit: "tokens",
  limit: LIMIT,
  spent: ledger.spent,
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
const replica = (reservationTtlMs: number) => {
  const app = createDb(inject("appUrl"), { max: 4 });
  dbs.push(app);
  return new BudgetGate(
    {
      load: async () => ({ lines: [siteLine()], requestsPerMinute: 10_000 }),
      prices: async () => new Map(),
    },
    {
      ttlMs: CACHE_TTL_MS,
      reservations: new DbReservations(app.db, { ttlMs: reservationTtlMs, salt }),
      settleHoldMs: CACHE_TTL_MS,
    },
  );
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const liveHolds = async () => {
  const r = await owner.db.execute<{ n: string }>(
    sql`SELECT count(*) AS n FROM install_budget_reservations WHERE expires_at > clock_timestamp()`,
  );
  return Number(r.rows[0]?.n ?? 0);
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
    const gates = [replica(60_000), replica(60_000)];
    let admitted = 0;
    // 40 members over 3 teams, half on each replica, each making calls back to back for ~2 s.
    const worker = async (i: number) => {
      const gate = gates[i % 2];
      const c = () =>
        call(teamIds[i % 3] ?? "", `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
      const end = Date.now() + 2_000;
      while (Date.now() < end) {
        const ctx = c();
        const d = await gate?.admit(ctx);
        if (!d?.ok) {
          await sleep(20);
          continue;
        }
        admitted++;
        await sleep(15);
        ledger.spent += CALL; // the usage row lands
        d.release?.(true);
        await sleep(5);
        gate?.settle(ctx.teamId, [ctx.callId ?? ""]);
      }
    };
    await Promise.all(Array.from({ length: 40 }, (_, i) => worker(i)));
    const overshoot = Math.max(0, ledger.spent - LIMIT);
    console.info(
      `KOBE-121 site line: limit ${LIMIT}, one call ${CALL}, admitted ${admitted}, spent ${ledger.spent}, overshoot ${overshoot}`,
    );
    expect(ledger.spent).toBe(admitted * CALL);
    expect(overshoot).toBeLessThanOrEqual(CALL);
    expect(admitted).toBeGreaterThanOrEqual(ALLOWED);
  });

  it("a crashed replica's holds free the budget by themselves and leave no live row", async () => {
    // Wait out the previous test's settled holds.
    await sleep(CACHE_TTL_MS + 200);
    ledger.spent = 0;
    const crashing = replica(400);
    const healthy = replica(60_000);
    // The crashing replica takes the whole budget (20 calls and a half) and then dies.
    let held = 0;
    for (let i = 0; i < ALLOWED + 1; i++) {
      const d = await crashing.admit(call(teamIds[i % 3] ?? "", randomUUID()));
      if (d.ok) held++;
    }
    expect(held).toBe(ALLOWED + 1);
    expect((await healthy.admit(call(teamIds[0] ?? "", randomUUID()))).ok).toBe(false);
    await sleep(600);
    expect(await liveHolds()).toBe(0);
    const again = await healthy.admit(call(teamIds[0] ?? "", randomUUID()));
    expect(again.ok).toBe(true);
    if (again.ok) again.release?.(false);
    await sleep(100);
    expect(await liveHolds()).toBe(0);
  });
});

import { randomUUID } from "node:crypto";
import { createDb, sql, teams, type BudgetLine, type KobeDatabase } from "@kobe/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { BudgetGate } from "./budget-gate.js";
import { DbReservations } from "./reservations-db.js";
import type { CallContext } from "./seams.js";

/**
 * KOBE-120 with real Postgres: reservations are shared through the database (a second gate on
 * the same database sees the first's), end on release and settle, and expire by themselves.
 * (The full two-replica race is KOBE-121.)
 */
let app: KobeDatabase;
const team = randomUUID();
const line: BudgetLine = {
  scope: "user",
  userId: undefined,
  period: "month",
  periodStart: "2026-10-01",
  unit: "tokens",
  limit: 1000,
  spent: 0,
};
const call = (userId: string): CallContext => ({
  teamId: team,
  userId,
  sandboxId: randomUUID(),
  runId: undefined,
  route: "openai",
  path: "/v1/chat/completions",
  model: undefined,
  inputEstimate: 400,
  outputAllowance: 100,
  callId: randomUUID(),
});
const gateOn = (ttlMs: number) =>
  new BudgetGate(
    {
      load: async () => ({ lines: [line], requestsPerMinute: 10_000 }),
      prices: async () => new Map(),
    },
    { ttlMs: 1_000, reservations: new DbReservations(app.db, { ttlMs }) },
  );

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values({ id: team, slug: `r-${team.slice(0, 8)}`, name: "R" });
  await owner.close();
  app = createDb(inject("appUrl"), { max: 4 });
});
afterAll(() => app.close());

describe("DbReservations through BudgetGate (KOBE-120)", () => {
  it("a second gate sees the first's reservation; release and settle end it", async () => {
    const a = gateOn(60_000);
    const b = gateOn(60_000);
    const user = randomUUID();
    // 500 tokens per call, 1000 limit: two calls fit, the third is refused, on either gate.
    const first = await a.admit(call(user));
    const second = await b.admit(call(user));
    if (!first.ok || !second.ok) throw new Error("refused");
    expect(await a.admit(call(user))).toMatchObject({ ok: false, code: "budget_exhausted" });
    expect(await b.admit(call(user))).toMatchObject({ ok: false, code: "budget_exhausted" });
    first.release?.(false);
    await new Promise((r) => setTimeout(r, 100));
    expect((await b.admit(call(user))).ok).toBe(true);
  });

  it("settle ends a written call's reservation", async () => {
    const g = gateOn(60_000);
    const user = randomUUID();
    const c = call(user);
    const d = await g.admit(c);
    const d2 = await g.admit(call(user));
    if (!d.ok || !d2.ok) throw new Error("refused");
    d.release?.(true);
    expect(await g.admit(call(user))).toMatchObject({ ok: false });
    g.settle(team, [c.callId ?? ""]);
    await new Promise((r) => setTimeout(r, 100));
    expect((await g.admit(call(user))).ok).toBe(true);
  });

  it("a crashed replica's reservation expires on its own, even before any sweep (ac-1, ac-2)", async () => {
    const user = randomUUID();
    const crashing = gateOn(300);
    expect((await crashing.admit(call(user))).ok).toBe(true);
    expect((await crashing.admit(call(user))).ok).toBe(true);
    // The "replica" never releases. A healthy one is refused until the expiry, then admitted.
    const healthy = gateOn(60_000);
    expect(await healthy.admit(call(user))).toMatchObject({ ok: false });
    await new Promise((r) => setTimeout(r, 450));
    expect((await healthy.admit(call(user))).ok).toBe(true);
  });

  it("measures the added latency of a reserve and an end (printed, not asserted)", async () => {
    const store = new DbReservations(app.db, { ttlMs: 60_000 });
    const n = 100;
    const user = randomUUID();
    const pingMs: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      await app.db.execute(sql`SELECT 1`);
      pingMs.push(performance.now() - t);
    }
    const reserveMs: number[] = [];
    const endMs: number[] = [];
    for (let i = 0; i < n; i++) {
      const callId = randomUUID();
      let t = performance.now();
      await store.reserve({
        teamId: team,
        userId: user,
        callId,
        cost: { usd: 0, tokens: 1 },
        lines: [{ ...line, limit: 1e9 }],
      });
      reserveMs.push(performance.now() - t);
      t = performance.now();
      await store.end(team, [callId]);
      endMs.push(performance.now() - t);
    }
    const p = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * q)];
    console.info(
      `KOBE-120 latency over ${n} calls: SELECT 1 p50 ${p(pingMs, 0.5)?.toFixed(2)} ms; reserve p50 ${p(reserveMs, 0.5)?.toFixed(2)} ms, p95 ${p(reserveMs, 0.95)?.toFixed(2)} ms; end p50 ${p(endMs, 0.5)?.toFixed(2)} ms, p95 ${p(endMs, 0.95)?.toFixed(2)} ms`,
    );
    expect(reserveMs).toHaveLength(n);
  });
});

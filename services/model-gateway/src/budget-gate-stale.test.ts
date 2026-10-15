import { randomUUID } from "node:crypto";
import type { BudgetLine, MemberBudgetState } from "@kobe/db";
import { describe, expect, it } from "vitest";
import { BudgetGate } from "./budget-gate.js";
import { MemoryReservations } from "./reservations-memory.js";
import type { ReservationStore, ReserveRequest, ReserveVerdict } from "./reservations.js";
import type { CallContext } from "./seams.js";

/**
 * KOBE-278 / KOBE-261: a check counts the calls written after the gate read the spend only
 * through their settled holds, which last `settleHoldMs` from the settle. A check that ran later
 * than that after the read (an old cache entry plus a slow pool or advisory-lock queue) may
 * miss them, so the gate checks again against a fresh spend. Fake clock throughout.
 */
const HOLD = 300;
const teamId = randomUUID();
const call = (userId: string): CallContext => ({
  teamId,
  userId,
  sandboxId: randomUUID(),
  runId: undefined,
  route: "openai",
  path: "/v1/chat/completions",
  model: undefined,
  inputEstimate: 80,
  outputAllowance: 20,
  callId: randomUUID(),
});
const site = (spent: number): BudgetLine => ({
  scope: "site",
  userId: undefined,
  period: "day",
  periodStart: "2026-10-15",
  unit: "tokens",
  limit: 1_000,
  spent,
});

/** Memory reservations whose reserve takes `delays[i]` ms on the fake clock (queue, lock). */
class SlowStore implements ReservationStore {
  readonly inner = new MemoryReservations();
  readonly requests: ReserveRequest[] = [];
  readonly ended: { ids: readonly string[]; keepMs: number | undefined }[] = [];
  constructor(
    private readonly now: { t: number },
    private readonly delays: number[],
  ) {}
  async reserve(r: ReserveRequest): Promise<ReserveVerdict> {
    this.now.t += this.delays.shift() ?? 0;
    this.requests.push(r);
    return this.inner.reserve(r);
  }
  extend(): Promise<void> {
    return Promise.resolve();
  }
  end(team: string, ids: readonly string[], keepMs?: number): Promise<void> {
    this.ended.push({ ids, keepMs });
    return this.inner.end(team, ids, keepMs);
  }
}

function setup(delays: number[], spends: number[], settleHoldMs = HOLD) {
  const now = { t: 0 };
  const store = new SlowStore(now, delays);
  let loads = 0;
  const g = new BudgetGate(
    {
      load: async (): Promise<MemberBudgetState> => {
        const spent = spends[Math.min(loads, spends.length - 1)] ?? 0;
        loads++;
        return { lines: [site(spent)], requestsPerMinute: 10_000 };
      },
      prices: async () => new Map(),
    },
    { ttlMs: HOLD, now: () => now.t, reservations: store, settleHoldMs },
  );
  return { g, now, store, loads: () => loads };
}

describe("BudgetGate: a spend read older than the settled holds (KOBE-278)", () => {
  it("a check that ends within the hold window needs no fresh read", async () => {
    const { g, loads } = setup([HOLD - 1], [0]);
    expect((await g.admit(call(randomUUID()))).ok).toBe(true);
    expect(loads()).toBe(1);
  });

  it("a slow check is repeated against a fresh spend, and refused when that is used up", async () => {
    // Read at t=0 (spent 0); the check lands at t=HOLD, when holds settled after t=0 may be gone.
    const { g, store, loads } = setup([HOLD, 0], [0, 1_000]);
    const c = call(randomUUID());
    expect(await g.admit(c)).toMatchObject({ ok: false, status: 402, code: "budget_exhausted" });
    expect(loads()).toBe(2);
    // The unproven reservation was ended outright, and nothing is left held.
    expect(store.ended).toContainEqual({ ids: [c.callId], keepMs: undefined });
    const other = await setupFreshAdmit(store);
    expect(other).toBe(true);
  });

  it("a slow check is repeated against a fresh spend, and admitted when that leaves room", async () => {
    const { g, store, loads } = setup([HOLD + 50, 0], [0, 500]);
    const d = await g.admit(call(randomUUID()));
    expect(d.ok).toBe(true);
    expect(loads()).toBe(2);
    expect(store.requests.map((r) => r.lines[0]?.spent)).toEqual([0, 500]);
  });

  it("the cache entry's age counts: an old entry plus a short delay is re-checked", async () => {
    const { g, now, store, loads } = setup([0, 60, 0], [0, 0, 400]);
    const user = randomUUID();
    expect((await g.admit(call(user))).ok).toBe(true);
    now.t += HOLD - 50; // a cache hit, 250 ms old
    expect((await g.admit(call(user))).ok).toBe(true);
    expect(loads()).toBe(2);
    expect(store.requests.map((r) => r.lines[0]?.spent)).toEqual([0, 0, 0]);
  });

  it("fails closed (503) when the repeated check is slow too, and holds nothing", async () => {
    const { g, store } = setup([HOLD, HOLD], [0, 0]);
    const c = call(randomUUID());
    expect(await g.admit(c)).toMatchObject({
      ok: false,
      status: 503,
      code: "budget_unavailable",
    });
    expect(store.ended.filter((e) => e.ids[0] === c.callId && e.keepMs === undefined)).toHaveLength(
      2,
    );
    expect(await setupFreshAdmit(store)).toBe(true);
  });

  it("without settled holds (settleHoldMs 0) there is nothing to prove: no re-check", async () => {
    const { g, loads } = setup([10 * HOLD], [0, 1_000], 0);
    expect((await g.admit(call(randomUUID()))).ok).toBe(true);
    expect(loads()).toBe(1);
  });
});

/** Whether the store holds nothing: a call of the whole budget is admitted on a fresh gate. */
async function setupFreshAdmit(store: SlowStore): Promise<boolean> {
  const r = await store.inner.reserve({
    teamId,
    userId: randomUUID(),
    callId: randomUUID(),
    cost: { usd: 0, tokens: 999 },
    lines: [{ ...site(0), limit: 1_000 }],
  });
  // With anything still held by another member, the 25 % share refuses a call this large.
  return r.ok;
}

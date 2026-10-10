import { randomUUID } from "node:crypto";
import type { BudgetLine, MemberBudgetState } from "@kobe/db";
import { describe, expect, it } from "vitest";
import { BudgetGate } from "./budget-gate.js";
import type { ReservationStore } from "./reservations.js";
import { parseVerdict } from "./reservations-db.js";
import type { CallContext } from "./seams.js";

const teamId = randomUUID();
const call = (userId: string): CallContext => ({
  teamId,
  userId,
  sandboxId: randomUUID(),
  // The advisory run id plays no part in enforcement (KOBE-41).
  runId: undefined,
  route: "openai",
  path: "/v1/chat/completions",
  model: "openai/m",
  inputEstimate: 100,
  outputAllowance: 100,
  callId: randomUUID(),
});

const line = (over: Partial<BudgetLine>): BudgetLine => ({
  scope: "team",
  userId: undefined,
  period: "month",
  periodStart: "2026-10-01",
  unit: "usd",
  limit: 10,
  spent: 1,
  ...over,
});

function gate(state: () => MemberBudgetState, now = { t: 0 }) {
  let loads = 0;
  const g = new BudgetGate(
    {
      load: async () => {
        loads++;
        return state();
      },
      prices: async () => new Map([["openai/m", { input: 1_000_000, output: 1_000_000 }]]),
    },
    { ttlMs: 1_000, now: () => now.t },
  );
  return { g, loads: () => loads };
}

describe("BudgetGate (KOBE-42)", () => {
  it("admits calls under budget and refuses once any level is used up (402), widest first", async () => {
    let lines: BudgetLine[] = [line({})];
    const { g } = gate(() => ({ lines, requestsPerMinute: 1_000 }));
    const user = randomUUID();
    expect(await g.admit(call(user))).toMatchObject({ ok: true });
    lines = [
      line({ scope: "user", userId: user, period: "day", limit: 1, spent: 1 }),
      line({ scope: "install", spent: 10 }),
    ];
    g.invalidateTeam(teamId);
    expect(await g.admit(call(user))).toEqual({
      ok: false,
      status: 402,
      code: "budget_exhausted",
      message: "The install's monthly model budget is used up.",
    });
  });

  it("caches a member's state for its TTL; a hint for the team drops it", async () => {
    const now = { t: 0 };
    const { g, loads } = gate(() => ({ lines: [], requestsPerMinute: 1_000 }), now);
    const user = randomUUID();
    await g.admit(call(user));
    await g.admit(call(user));
    expect(loads()).toBe(1);
    g.invalidateTeam(teamId);
    await g.admit(call(user));
    expect(loads()).toBe(2);
    now.t += 1_001;
    await g.admit(call(user));
    expect(loads()).toBe(3);
  });

  it("rate-limits each member to their requests per minute (429 with Retry-After)", async () => {
    const now = { t: 0 };
    const { g } = gate(() => ({ lines: [], requestsPerMinute: 2 }), now);
    const alice = randomUUID();
    expect((await g.admit(call(alice))).ok).toBe(true);
    expect((await g.admit(call(alice))).ok).toBe(true);
    const third = await g.admit(call(alice));
    expect(third).toMatchObject({ ok: false, status: 429, code: "rate_limited" });
    expect(third.ok === false && third.retryAfterSeconds).toBe(30);
    // Another member has their own bucket.
    expect((await g.admit(call(randomUUID()))).ok).toBe(true);
    now.t += 30_000;
    expect((await g.admit(call(alice))).ok).toBe(true);
  });

  it("a used-up token budget refuses calls too (models without prices included)", async () => {
    const { g } = gate(() => ({
      lines: [line({ unit: "tokens", period: "day", limit: 1_000, spent: 1_200 })],
      requestsPerMinute: 10,
    }));
    expect(await g.admit(call(randomUUID()))).toMatchObject({
      ok: false,
      status: 402,
      code: "budget_exhausted",
      message: "Your team's daily token budget is used up.",
    });
  });

  it("reserves an admitted call's possible cost until it ends (concurrent calls cannot overshoot)", async () => {
    // $1 per token here: 200 tokens reserved = $200 per call; $1,000 left of the team's budget.
    const { g } = gate(() => ({
      lines: [
        line({ limit: 10_000, spent: 9_000 }),
        line({ unit: "tokens", limit: 1e6, spent: 0 }),
      ],
      requestsPerMinute: 1_000,
    }));
    // Five members, one call each: 5 × 200 reaches the $1,000 left.
    const admitted = [];
    for (let i = 0; i < 5; i++) admitted.push(await g.admit(call(randomUUID())));
    expect(admitted.every((d) => d.ok)).toBe(true);
    expect(await g.admit(call(randomUUID()))).toMatchObject({
      ok: false,
      code: "budget_exhausted",
    });
    const first = admitted[0];
    if (first?.ok) first.release?.(false);
    expect((await g.admit(call(randomUUID()))).ok).toBe(true);
  });

  it("one member cannot hold a shared budget with reservations (fair share)", async () => {
    const { g } = gate(() => ({
      lines: [line({ limit: 10_000, spent: 9_000 })],
      requestsPerMinute: 1_000,
    }));
    const hog = randomUUID();
    // The hog's share of the $1,000 left is $250: its second $200 call is refused (429), not
    // everyone else's.
    expect((await g.admit(call(hog))).ok).toBe(true);
    expect(await g.admit(call(hog))).toMatchObject({ ok: false, code: "too_many_calls_in_flight" });
    expect((await g.admit(call(randomUUID()))).ok).toBe(true);
  });

  it("the share caps a member's first call too once others hold reservations", async () => {
    // $150 left: a member's share is $37.5, below one $200 call.
    const { g } = gate(() => ({
      lines: [line({ limit: 10_000, spent: 9_850 })],
      requestsPerMinute: 1_000,
    }));
    // Nothing reserved yet: a lone call is admitted.
    expect((await g.admit(call(randomUUID()))).ok).toBe(true);
    // A newcomer with no reservation of their own is capped by their share.
    expect(await g.admit(call(randomUUID()))).toMatchObject({
      ok: false,
      code: "too_many_calls_in_flight",
    });
  });

  it("admits at most what a nearly used-up limit allows under concurrent calls", async () => {
    // $1,000 left on a user line (no share cap), $200 per call: five calls fit, no more, even
    // though all twenty are decided at once (the price load is awaited before the check).
    const { g } = gate(() => ({
      lines: [line({ scope: "user", limit: 10_000, spent: 9_000 })],
      requestsPerMinute: 1_000,
    }));
    const user = randomUUID();
    const decisions = await Promise.all(Array.from({ length: 20 }, () => g.admit(call(user))));
    expect(decisions.filter((d) => d.ok)).toHaveLength(5);
  });

  it("keeps a written call's reservation until its ledger row lands (settle)", async () => {
    const { g } = gate(() => ({
      lines: [line({ unit: "tokens", scope: "user", limit: 200, spent: 0 })],
      requestsPerMinute: 1_000,
    }));
    const user = randomUUID();
    const c = call(user);
    const d = await g.admit(c);
    if (!d.ok) throw new Error("refused");
    d.release?.(true);
    // The call ended but its row has not landed: its 200 tokens stay reserved (of 200).
    expect(await g.admit(call(user))).toMatchObject({ ok: false, code: "budget_exhausted" });
    g.settle(teamId, [c.callId ?? ""]);
    expect((await g.admit(call(user))).ok).toBe(true);
  });

  it("a zero budget allows nothing", async () => {
    const { g } = gate(() => ({
      lines: [line({ limit: 0, spent: 0 })],
      requestsPerMinute: 10,
    }));
    expect((await g.admit(call(randomUUID()))).ok).toBe(false);
  });

  describe("with a shared reservation store (KOBE-120)", () => {
    const failing: ReservationStore = {
      reserve: async () => {
        throw new Error("db down");
      },
      end: async () => undefined,
      extend: async () => undefined,
    };
    const lines = () => ({
      lines: [line({ unit: "tokens", scope: "user", limit: 1e6, spent: 0 })],
      requestsPerMinute: 1_000,
    });

    it("fails closed (503) when the store is down, and logs it", async () => {
      const errors: unknown[] = [];
      const g = new BudgetGate(
        { load: async () => lines(), prices: async () => new Map() },
        { ttlMs: 1_000, reservations: failing, onError: (e) => errors.push(e) },
      );
      expect(await g.admit(call(randomUUID()))).toMatchObject({
        ok: false,
        status: 503,
        code: "budget_unavailable",
      });
      expect(errors).toHaveLength(1);
    });

    it("ends the reservation through the store: now, or kept while the row is pending", async () => {
      const ended: { calls: readonly string[]; keepMs: number | undefined }[] = [];
      const store: ReservationStore = {
        reserve: async () => ({ ok: true }),
        extend: async () => undefined,
        end: async (_t, calls, keepMs) => {
          ended.push({ calls, keepMs });
        },
      };
      const g = new BudgetGate(
        { load: async () => lines(), prices: async () => new Map() },
        { ttlMs: 1_000, reservations: store },
      );
      const a = call(randomUUID());
      const b = call(randomUUID());
      const da = await g.admit(a);
      const db = await g.admit(b);
      if (!da.ok || !db.ok) throw new Error("refused");
      da.release?.(false);
      db.release?.(true);
      g.settle(teamId, [b.callId ?? ""]);
      expect(ended).toEqual([
        { calls: [a.callId], keepMs: undefined },
        { calls: [b.callId], keepMs: 30_000 },
        { calls: [b.callId], keepMs: undefined },
      ]);
    });

    it("holds a settled reservation for the budget cache TTL, and extends running calls", async () => {
      const ended: (number | undefined)[] = [];
      let beats = 0;
      const store: ReservationStore = {
        reserve: async () => ({ ok: true }),
        extend: async () => {
          beats++;
        },
        end: async (_t, _c, keepMs) => {
          ended.push(keepMs);
        },
      };
      const g = new BudgetGate(
        { load: async () => lines(), prices: async () => new Map() },
        { ttlMs: 1_000, reservations: store, settleHoldMs: 1_000, heartbeatMs: 10 },
      );
      const c = call(randomUUID());
      const d = await g.admit(c);
      if (!d.ok) throw new Error("refused");
      await new Promise((r) => setTimeout(r, 60));
      expect(beats).toBeGreaterThanOrEqual(2);
      d.release?.(true);
      const seen = beats;
      await new Promise((r) => setTimeout(r, 40));
      expect(beats).toBe(seen); // the heartbeat stops with the call
      g.settle(teamId, [c.callId ?? ""]);
      expect(ended).toEqual([30_000, 1_000]);
    });

    it("a refused reservation gives the rate-limit token back", async () => {
      const store: ReservationStore = {
        reserve: async () => ({ ok: false, verdict: "full", line: 0 }),
        end: async () => undefined,
        extend: async () => undefined,
      };
      const g = new BudgetGate(
        {
          load: async () => ({ ...lines(), requestsPerMinute: 1 }),
          prices: async () => new Map(),
        },
        { ttlMs: 1_000, reservations: store },
      );
      const user = randomUUID();
      // With one request per minute, a second refusal would be 429 if the token were kept.
      expect(await g.admit(call(user))).toMatchObject({ status: 402 });
      expect(await g.admit(call(user))).toMatchObject({ status: 402 });
    });
  });

  it("parses the reserve function's answers", () => {
    expect(parseVerdict("ok")).toEqual({ ok: true });
    expect(parseVerdict("full:2")).toEqual({ ok: false, verdict: "full", line: 2 });
    expect(parseVerdict("own_share:0")).toEqual({ ok: false, verdict: "own_share", line: 0 });
    expect(() => parseVerdict(undefined)).toThrow();
  });
});

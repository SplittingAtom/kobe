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

describe("BudgetGate: server calls (KOBE-234)", () => {
  const at = (spent: number): MemberBudgetState => ({
    lines: [line({ limit: 1_000, spent })],
    requestsPerMinute: 1_000,
  });
  const server = (user: string, purpose: "title" | "followups"): CallContext => ({
    ...call(user),
    sandboxId: undefined,
    runId: randomUUID(),
    purpose,
  });

  it("refuses follow-ups at 80 % of any budget line, never titles or sandbox calls", async () => {
    let state = at(800);
    const { g: inner } = gate(() => state);
    // Each admitted call ends at once, so no reservation carries over to the next assertion.
    const g = {
      admit: async (c: CallContext) => {
        const d = await inner.admit(c);
        if (d.ok) d.release?.(false);
        return d;
      },
      invalidateTeam: (t: string) => inner.invalidateTeam(t),
    };
    const user = randomUUID();
    expect(await g.admit(server(user, "followups"))).toEqual({
      ok: false,
      status: 402,
      code: "budget_soft_limit",
      message: "Your team's monthly model budget is at 80 % or more: follow-ups are skipped.",
    });
    expect(await g.admit(server(user, "title"))).toMatchObject({ ok: true });
    expect(await g.admit(call(user))).toMatchObject({ ok: true });
    state = at(799);
    g.invalidateTeam(teamId);
    expect(await g.admit(server(user, "followups"))).toMatchObject({ ok: true });
  });

  it("judges follow-ups in the reservation at 80 % of each line, not on the cached spend (review L2)", async () => {
    const seen: BudgetLine[][] = [];
    const store: ReservationStore = {
      reserve: async (r) => {
        seen.push([...r.lines]);
        // The database's own read: spend + reservations reach the (scaled) limit.
        return { ok: false, verdict: "full", line: 0 };
      },
      extend: async () => undefined,
      end: async () => undefined,
    };
    const g = new BudgetGate(
      {
        // Stale cache: 10 % spent.
        load: async () => ({
          lines: [line({ limit: 1_000, spent: 100, limitExact: "1000.5", spentExact: "100" })],
          requestsPerMinute: 1_000,
        }),
        prices: async () => new Map([["openai/m", { input: 1_000_000, output: 1_000_000 }]]),
      },
      { ttlMs: 1_000, now: () => 0, reservations: store },
    );
    expect(await g.admit(server(randomUUID(), "followups"))).toMatchObject({
      ok: false,
      status: 402,
      code: "budget_soft_limit",
    });
    expect(seen[0]?.[0]).toMatchObject({ limit: 800, limitExact: "800.400000000000" });
    // Titles and sandbox calls are judged on the full limit.
    await g.admit(server(randomUUID(), "title"));
    expect(seen[1]?.[0]).toMatchObject({ limit: 1_000, limitExact: "1000.5" });
  });

  it("stops titles at 100 % like any call", async () => {
    const { g } = gate(() => at(1_000));
    expect(await g.admit(server(randomUUID(), "title"))).toMatchObject({
      ok: false,
      code: "budget_exhausted",
    });
  });
});

describe("BudgetGate (KOBE-42)", () => {
  it("admits calls under budget and refuses once any level is used up (402), widest first", async () => {
    // $1,000: above the call's $100 input (KOBE-259: a request larger than the budget is refused).
    let lines: BudgetLine[] = [line({ limit: 1_000 })];
    const { g } = gate(() => ({ lines, requestsPerMinute: 1_000 }));
    const user = randomUUID();
    expect(await g.admit(call(user))).toMatchObject({ ok: true });
    lines = [
      line({ scope: "user", userId: user, period: "day", limit: 1, spent: 1 }),
      line({ scope: "site", spent: 10 }),
    ];
    g.invalidateTeam(teamId);
    expect(await g.admit(call(user))).toEqual({
      ok: false,
      status: 402,
      code: "budget_exhausted",
      message: "The site's monthly model budget is used up.",
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

  describe("large output allowances (KOBE-259)", () => {
    const big = (userId: string): CallContext => ({
      ...call(userId),
      callId: randomUUID(),
      inputEstimate: 1_000,
      outputAllowance: 131_072,
    });

    it("reserves a large allowance in full: concurrent calls stop once the budget is reserved", async () => {
      const { g } = gate(() => ({
        lines: [line({ unit: "tokens", scope: "user", limit: 300_000, spent: 0 })],
        requestsPerMinute: 1_000,
      }));
      const user = randomUUID();
      const decisions = [];
      for (let i = 0; i < 4; i++) decisions.push(await g.admit(big(user)));
      // 3 × 132,072 reserved: the third overshoots by its own allowance at most; the fourth waits.
      expect(decisions.map((d) => d.ok)).toEqual([true, true, true, false]);
      expect(decisions[3]).toMatchObject({ status: 402, code: "budget_exhausted" });
    });

    it("a request whose input alone exceeds the budget's limit: refused deterministically, even alone", async () => {
      const { g } = gate(() => ({
        lines: [line({ unit: "tokens", scope: "team", limit: 500, spent: 0 })],
        requestsPerMinute: 1_000,
      }));
      const user = randomUUID();
      for (let i = 0; i < 3; i++) {
        expect(await g.admit(big(user))).toEqual({
          ok: false,
          status: 402,
          code: "budget_below_call",
          message:
            "This request's input is larger than your team's monthly token budget in total. Ask an admin to raise the budget, or start a new conversation with less context.",
        });
      }
    });

    it("a dollar budget below the request's priced input is refused the same way", async () => {
      const { g } = gate(() => ({
        lines: [line({ scope: "user", period: "day", limit: 0.5, spent: 0 })],
        requestsPerMinute: 1_000,
      }));
      // $1 per token at the test price: 1,000 input tokens far exceed $0.50.
      expect(await g.admit(big(randomUUID()))).toMatchObject({
        status: 402,
        code: "budget_below_call",
        message: expect.stringContaining("larger than your daily model budget"),
      });
    });

    it("a budget below one call's output allowance still serves a lone call, as before", async () => {
      const { g } = gate(() => ({
        lines: [line({ unit: "tokens", scope: "user", limit: 20_000, spent: 0 })],
        requestsPerMinute: 1_000,
      }));
      const user = randomUUID();
      // 1,000 input + 131,072 allowance: far above 20,000, but most calls use little output.
      expect((await g.admit(big(user))).ok).toBe(true);
      // Overlapping: the first call's reservation fills the budget; the old answer, not "too small".
      expect(await g.admit(big(user))).toMatchObject({ status: 402, code: "budget_exhausted" });
    });

    it("a nearly spent budget above one call: a lone call runs, then it is used up (not 'too small')", async () => {
      let spent = 999_000;
      const { g } = gate(() => ({
        lines: [line({ unit: "tokens", scope: "user", limit: 1_000_000, spent })],
        requestsPerMinute: 1_000,
      }));
      const user = randomUUID();
      expect((await g.admit(big(user))).ok).toBe(true);
      // Overlapping: the reservation fills what is left.
      expect(await g.admit(big(user))).toMatchObject({ status: 402, code: "budget_exhausted" });
      spent = 1_000_100;
      g.invalidateTeam(teamId);
      expect(await g.admit(big(user))).toMatchObject({ status: 402, code: "budget_exhausted" });
    });

    it("overlapping calls under a normal budget still wait and retry (429), never 'too small'", async () => {
      const { g } = gate(() => ({
        lines: [line({ unit: "tokens", scope: "team", limit: 1_000_000, spent: 0 })],
        requestsPerMinute: 1_000,
      }));
      const [a, b] = [randomUUID(), randomUUID()];
      expect((await g.admit(big(a))).ok).toBe(true);
      expect((await g.admit(big(b))).ok).toBe(true);
      // b's second call would hold more than its quarter of what is left while a's runs.
      expect(await g.admit(big(b))).toMatchObject({
        status: 429,
        code: "too_many_calls_in_flight",
        retryAfterSeconds: 2,
      });
    });
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

    it("ends the reservation through the store: now, or kept a full TTL while the row is pending", async () => {
      const ended: { calls: readonly string[]; keepMs: number | undefined }[] = [];
      const extended: (readonly string[])[] = [];
      const store: ReservationStore = {
        reserve: async () => ({ ok: true }),
        extend: async (_t, calls) => {
          extended.push(calls);
        },
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
      // KOBE-286 review L1: a written call's hold is not cut short while its row is on its way
      // (it would count zero times if the row landed late): renewed for a full TTL, then ended
      // by the settle.
      expect(extended).toEqual([[b.callId]]);
      expect(ended).toEqual([
        { calls: [a.callId], keepMs: undefined },
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
      expect(ended).toEqual([1_000]);
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

describe("BudgetGate: the team eval cap (KOBE-327)", () => {
  const cap = (spent: number) =>
    line({
      scope: "eval",
      unit: "usd",
      limit: 5,
      spent,
      limitExact: "5",
      spentExact: String(spent),
    });
  const state = (spent: number): MemberBudgetState => ({
    lines: [line({ limit: 1_000, spent: 0 })],
    evalLines: [cap(spent)],
    requestsPerMinute: 1_000,
  });

  it("stops an eval sandbox's and the judge's calls at the cap; other calls never see it", async () => {
    const { g } = gate(() => state(5));
    const user = randomUUID();
    const evalCall = { ...call(user), eval: true };
    const judge = {
      ...call(user),
      sandboxId: undefined,
      runId: randomUUID(),
      purpose: "eval_judge" as const,
    };
    for (const c of [evalCall, judge])
      expect(await g.admit(c)).toEqual({
        ok: false,
        status: 402,
        code: "budget_exhausted",
        message: "Your team's monthly eval cap is used up.",
      });
    const plain = await g.admit(call(user));
    expect(plain.ok).toBe(true);
    if (plain.ok) plain.release?.(false);
  });

  it("holds eval calls' reservations against the cap (in memory as in Postgres)", async () => {
    // 200 tokens held per call in flight against a cap of 200 tokens.
    const { g } = gate(() => ({
      lines: [],
      evalLines: [
        line({
          scope: "eval",
          unit: "tokens",
          limit: 200,
          spent: 0,
          limitExact: "200",
          spentExact: "0",
        }),
      ],
      requestsPerMinute: 1_000,
    }));
    const first = await g.admit({ ...call(randomUUID()), eval: true });
    expect(first.ok).toBe(true);
    const second = await g.admit({ ...call(randomUUID()), eval: true });
    // Refused while the first holds its share of what is left (the reservation path's rule).
    expect(second).toMatchObject({ ok: false, status: 429, code: "too_many_calls_in_flight" });
    // An ordinary call is not judged by the cap and holds nothing against it.
    const plain = await g.admit(call(randomUUID()));
    expect(plain.ok).toBe(true);
    if (first.ok) first.release?.(false);
    const third = await g.admit({ ...call(randomUUID()), eval: true });
    expect(third.ok).toBe(true);
  });
});

describe("BudgetGate: an eval cap on a team without budgets (KOBE-327 review L5)", () => {
  it("still reserves an eval call against the cap alone", async () => {
    const seen: { scopes: string[] }[] = [];
    const store: ReservationStore = {
      reserve: async (r) => {
        seen.push({ scopes: r.lines.map((l) => l.scope) });
        return { ok: true };
      },
      extend: async () => undefined,
      end: async () => undefined,
    };
    const g = new BudgetGate(
      {
        load: async () => ({
          lines: [],
          evalLines: [line({ scope: "eval", unit: "tokens", limit: 10_000, spent: 0 })],
          requestsPerMinute: 1_000,
        }),
        prices: async () => new Map(),
      },
      { ttlMs: 1_000, reservations: store },
    );
    const evalCall = await g.admit({ ...call(randomUUID()), eval: true });
    expect(evalCall.ok).toBe(true);
    const plain = await g.admit(call(randomUUID()));
    expect(plain.ok).toBe(true);
    // Only the eval call reserved (the plain one has no line at all).
    expect(seen).toEqual([{ scopes: ["eval"] }]);
  });
});

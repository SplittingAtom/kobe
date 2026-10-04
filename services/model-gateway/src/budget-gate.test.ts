import { randomUUID } from "node:crypto";
import type { BudgetLine, MemberBudgetState } from "@kobe/db";
import { describe, expect, it } from "vitest";
import { BudgetGate } from "./budget-gate.js";
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
});

const line = (over: Partial<BudgetLine>): BudgetLine => ({
  scope: "team",
  userId: undefined,
  period: "month",
  periodStart: "2026-10-01",
  limitUsd: 10,
  spentUsd: 1,
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
    expect(await g.admit(call(user))).toEqual({ ok: true });
    lines = [
      line({ scope: "user", userId: user, period: "day", limitUsd: 1, spentUsd: 1 }),
      line({ scope: "install", spentUsd: 10 }),
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

  it("a zero budget allows nothing", async () => {
    const { g } = gate(() => ({
      lines: [line({ limitUsd: 0, spentUsd: 0 })],
      requestsPerMinute: 10,
    }));
    expect((await g.admit(call(randomUUID()))).ok).toBe(false);
  });
});

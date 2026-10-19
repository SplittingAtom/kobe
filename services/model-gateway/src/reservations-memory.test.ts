import { randomUUID } from "node:crypto";
import type { BudgetLine } from "@kobe/db";
import { describe, expect, it } from "vitest";
import { MemoryReservations } from "./reservations-memory.js";

/**
 * KOBE-443: like `kobe_reserve_budget`, the memory store counts every live hold in full. Holds a
 * member took while the share was larger must not be re-capped at the smaller share left once
 * spend has grown, or a call is admitted past the limit.
 */
const team = randomUUID();
const CALL = 65;
const LIMIT = 683;

const teamLine = (spent: number): BudgetLine => ({
  scope: "team",
  userId: undefined,
  period: "day",
  periodStart: "2026-10-19",
  unit: "tokens",
  limit: LIMIT,
  spent,
});

describe("MemoryReservations (KOBE-443)", () => {
  it("counts holds taken at a larger share in full after the spend grew", async () => {
    const store = new MemoryReservations();
    const reserve = (userId: string, spent: number, callId = randomUUID()) =>
      store.reserve({
        teamId: team,
        userId,
        callId,
        cost: { usd: 0, tokens: CALL },
        lines: [teamLine(spent)],
      });
    const [a, b, c, d] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    // At spend 0 (share 170.75) a, b and c hold two calls each: 390 live.
    for (const who of [a, a, b, b, c, c]) expect((await reserve(who, 0)).ok).toBe(true);
    // 325 of other calls landed: share (683 - 325) x 0.25 = 89.5; true exposure 715 >= 683.
    expect(await reserve(d, 325)).toEqual({ ok: false, verdict: "full", line: 0 });
  });

  it("still caps one member at its share of what is left", async () => {
    const store = new MemoryReservations();
    const [hog, other] = [randomUUID(), randomUUID()];
    const at = (userId: string) =>
      store.reserve({
        teamId: team,
        userId,
        callId: randomUUID(),
        cost: { usd: 0, tokens: CALL },
        lines: [teamLine(0)],
      });
    // Share 170.75: two calls (130) fit, a third (195) does not.
    expect((await at(hog)).ok).toBe(true);
    expect((await at(hog)).ok).toBe(true);
    expect(await at(hog)).toEqual({ ok: false, verdict: "own_share", line: 0 });
    expect((await at(other)).ok).toBe(true);
  });
});

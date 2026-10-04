import { describe, expect, it } from "vitest";
import { lineUsedUp, scaledDecimal, thresholdReached, type BudgetLine } from "./budgets.js";

const line = (spent: string, limit: string): BudgetLine => ({
  scope: "team",
  userId: undefined,
  period: "month",
  periodStart: "2026-10-01",
  unit: "usd",
  limit: Number(limit),
  spent: Number(spent),
  limitExact: limit,
  spentExact: spent,
});

describe("exact budget comparison", () => {
  it("parses numeric text to integer units", () => {
    expect(scaledDecimal("12.5")).toBe(12_500_000_000_000n);
    expect(scaledDecimal("0.0000000001")).toBe(100n);
    expect(() => scaledDecimal("1e3")).toThrow();
  });

  it("sees a spend a float cannot tell from the limit", () => {
    // 10000000000000.0000000001 and 10000000000000 are the same double.
    const l = line("10000000000000.0000000001", "10000000000000.0000000002");
    expect(l.spent >= l.limit).toBe(true);
    expect(lineUsedUp(l)).toBe(false);
    expect(lineUsedUp(line("10000000000000.0000000002", "10000000000000.0000000002"))).toBe(true);
  });

  it("falls back to numbers without exact text", () => {
    const { spentExact: _s, limitExact: _l, ...bare } = line("5", "5");
    expect(lineUsedUp(bare)).toBe(true);
  });
});

describe("exact warning thresholds", () => {
  it("compares percentages without a float", () => {
    const l = line("7999999999999.9999999999", "10000000000000");
    expect(l.spent / l.limit >= 0.8).toBe(true);
    expect(thresholdReached(l, 80)).toBe(false);
    expect(thresholdReached(line("8000000000000", "10000000000000"), 80)).toBe(true);
    expect(thresholdReached(line("9999999999999.99", "10000000000000"), 100)).toBe(false);
    expect(thresholdReached(line("0", "0"), 80)).toBe(true);
  });
});

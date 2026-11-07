import { describe, expect, it } from "vitest";
import type { ThreadUsage } from "../../lib/admin/api/usage";
import { reasoningSpend } from "./use-reasoning-spend";

/**
 * KOBE-556: the readout's wiring: the thread's latest run's reasoning tokens (KOBE-557's
 * `reasoning_tokens`, reported or estimated) and the shown level's budget. Unknown either way:
 * nothing, so the control is the pill row alone.
 */
function usage(...runs: Record<string, unknown>[]): ThreadUsage {
  return {
    threadId: "t1",
    runs: runs.map((r, i) => ({
      runId: `r${i}`,
      models: [],
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      unpricedCalls: 0,
      estimatedCalls: 0,
      ...r,
    })),
  } as ThreadUsage;
}

describe("reasoningSpend (KOBE-556)", () => {
  it("nothing without a usage read, a run, or the run's reasoning tokens", () => {
    expect(reasoningSpend(null, "medium")).toEqual({});
    expect(reasoningSpend(usage(), "medium")).toEqual({});
    expect(reasoningSpend(usage({ reasoningTokens: null }), "medium")).toEqual({});
    expect(reasoningSpend(usage({}), "medium")).toEqual({});
  });

  it("the latest run's spend against the shown level's budget", () => {
    const read = usage({ reasoningTokens: 100 }, { reasoningTokens: 1500 });
    expect(reasoningSpend(read, "medium")).toEqual({
      spent: 1500,
      budget: 8000,
      estimated: false,
    });
    expect(reasoningSpend(read, "low")).toMatchObject({ budget: 2000 });
    expect(reasoningSpend(read, "high")).toMatchObject({ budget: 24000 });
  });

  it("an estimate says so", () => {
    const read = usage({ reasoningTokens: 900, reasoningEstimated: true });
    expect(reasoningSpend(read, "low")).toEqual({ spent: 900, budget: 2000, estimated: true });
  });

  it("no level shown (no default): no budget, so no readout", () => {
    expect(reasoningSpend(usage({ reasoningTokens: 900 }), null)).toEqual({});
  });
});

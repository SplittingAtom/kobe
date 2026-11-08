import { describe, expect, it } from "vitest";
import type { ThreadUsage } from "../../lib/admin/api/usage";
import { latestReasoning, reasoningSpend } from "./use-reasoning-spend";

/**
 * KOBE-556: the readout's wiring: the thread's latest run (by its newest call's time) with its
 * reasoning tokens (KOBE-557's `reasoning_tokens`, reported or estimated) and the level it ran
 * with. Unknown either way: nothing, so the control is the pill row alone.
 */
function usage(latestRun: string | null, ...runs: Record<string, unknown>[]): ThreadUsage {
  return {
    threadId: "t1",
    latestCall:
      latestRun === null
        ? null
        : {
            runId: latestRun,
            at: "2026-11-07T10:00:00Z",
            model: "p/m",
            inputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
    runs: runs.map((r) => ({
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
  } as unknown as ThreadUsage;
}

const RUNS = [
  { runId: "newest", reasoningTokens: 1500, thinkingLevel: "medium" },
  { runId: "older", reasoningTokens: 100, thinkingLevel: "low" },
];

describe("latestReasoning (KOBE-556)", () => {
  it("picks the run of the newest call, not the last array entry", () => {
    expect(latestReasoning(usage("newest", ...RUNS), null)).toEqual({
      runId: "newest",
      spent: 1500,
      level: "medium",
      estimated: false,
    });
  });

  it("nothing while the run streamed in this tab has no usage yet", () => {
    expect(latestReasoning(usage("newest", ...RUNS), "just-started")).toBeNull();
    expect(latestReasoning(usage("newest", ...RUNS), "newest")).toMatchObject({ spent: 1500 });
  });

  it("nothing without a read, a call, reasoning tokens or a recorded level", () => {
    expect(latestReasoning(null, null)).toBeNull();
    expect(latestReasoning(usage(null, ...RUNS), null)).toBeNull();
    expect(latestReasoning(usage("a", { runId: "a", reasoningTokens: null }), null)).toBeNull();
    expect(latestReasoning(usage("a", { runId: "a", thinkingLevel: "low" }), null)).toBeNull();
    expect(latestReasoning(usage("a", { runId: "a", reasoningTokens: 9 }), null)).toBeNull();
  });

  it("an estimate says so", () => {
    const read = usage("a", {
      runId: "a",
      reasoningTokens: 900,
      reasoningEstimated: true,
      thinkingLevel: "low",
    });
    expect(latestReasoning(read, null)).toMatchObject({ estimated: true });
  });
});

describe("reasoningSpend (KOBE-556 on KOBE-557)", () => {
  const latest = { runId: "a", spent: 1500, level: "medium", estimated: false } as const;

  it("grades the run against its level's budget in its control's form", () => {
    expect(reasoningSpend(latest, "reasoning_effort")).toEqual({
      spent: 1500,
      budget: 8000,
      estimated: false,
    });
    expect(reasoningSpend({ ...latest, level: "high" }, "anthropic_adaptive")).toMatchObject({
      budget: 24000,
    });
    expect(reasoningSpend({ ...latest, level: "low" }, "anthropic_effort")).toMatchObject({
      budget: 2000,
    });
  });

  it("an estimate keeps its marker", () => {
    expect(reasoningSpend({ ...latest, estimated: true }, "reasoning_effort")).toMatchObject({
      estimated: true,
    });
  });

  it("hidden while the budget is unknown: no control, control none, or no run", () => {
    expect(reasoningSpend(latest, null)).toEqual({});
    expect(reasoningSpend(latest, "none")).toEqual({});
    expect(reasoningSpend(null, "reasoning_effort")).toEqual({});
  });

  it("thinking off grades against a zero budget (the control hides the bar)", () => {
    expect(reasoningSpend({ ...latest, level: "off" }, "reasoning_effort")).toMatchObject({
      budget: 0,
    });
  });
});

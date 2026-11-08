import { describe, expect, it } from "vitest";
import type { TeamModels } from "../../lib/admin/api/team/models";
import type { ThreadUsage } from "../../lib/admin/api/usage";
import {
  lastRunLine,
  latestReasoning,
  reasoningSpend,
  thinkingControl,
  thinkingTokensLine,
} from "./session-reasoning";

/**
 * KOBE-584: Session info's reasoning rows. "Thinking tokens" sums the runs' KOBE-557 reasoning
 * tokens; "Last run" grades the thread's latest run against its level's budget.
 */
function usage(latestRun: string | null, ...runs: Record<string, unknown>[]): ThreadUsage {
  return {
    threadId: "t1",
    latestCall:
      latestRun === null
        ? null
        : {
            runId: latestRun,
            at: "2026-11-08T10:00:00Z",
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
  { runId: "older", reasoningTokens: 100, thinkingLevel: "low" },
  { runId: "newest", reasoningTokens: 1500, thinkingLevel: "medium" },
];

describe("thinkingTokensLine (KOBE-584)", () => {
  it("— when no run has a count", () => {
    expect(thinkingTokensLine([])).toBe("—");
    expect(thinkingTokensLine(usage(null, { runId: "a", reasoningTokens: null }).runs)).toBe("—");
    expect(thinkingTokensLine(usage(null, { runId: "a" }).runs)).toBe("—");
  });

  it("sums the counted runs; null runs contribute nothing", () => {
    const runs = usage(
      null,
      { runId: "a", reasoningTokens: 1200 },
      { runId: "b", reasoningTokens: null },
      { runId: "c", reasoningTokens: 300 },
    ).runs;
    expect(thinkingTokensLine(runs)).toBe("1.5k");
  });

  it("a counted 0 is a count, not unknown", () => {
    expect(thinkingTokensLine(usage(null, { runId: "a", reasoningTokens: 0 }).runs)).toBe("0");
  });

  it("≈ when any counted run is estimated; an uncounted estimated flag does not", () => {
    const runs = usage(
      null,
      { runId: "a", reasoningTokens: 800 },
      { runId: "b", reasoningTokens: 40, reasoningEstimated: true },
    ).runs;
    expect(thinkingTokensLine(runs)).toBe("≈840");
    const uncounted = usage(
      null,
      { runId: "a", reasoningTokens: 800 },
      { runId: "b", reasoningTokens: null, reasoningEstimated: true },
    ).runs;
    expect(thinkingTokensLine(uncounted)).toBe("800");
  });
});

describe("latestReasoning (KOBE-556, reused by KOBE-584)", () => {
  it("picks the run of the newest call, not the last array entry", () => {
    expect(latestReasoning(usage("older", ...RUNS), null)).toEqual({
      runId: "older",
      spent: 100,
      level: "low",
      estimated: false,
    });
  });

  it("excludes the live run until its usage lands", () => {
    expect(latestReasoning(usage("newest", ...RUNS), "just-started")).toBeNull();
    expect(latestReasoning(usage("newest", ...RUNS), "newest")).toMatchObject({ spent: 1500 });
  });

  it("nothing without a read, a call, reasoning tokens or a recorded level", () => {
    expect(latestReasoning(null, null)).toBeNull();
    expect(latestReasoning(usage(null, ...RUNS), null)).toBeNull();
    expect(latestReasoning(usage("a", { runId: "a", reasoningTokens: null }), null)).toBeNull();
    expect(
      latestReasoning(usage("a", { runId: "a", reasoningTokens: 5, thinkingLevel: null }), null),
    ).toBeNull();
  });
});

describe("reasoningSpend", () => {
  const latest = { runId: "r", spent: 1500, level: "medium", estimated: true } as const;
  it("grades against the run's level in the model's control", () => {
    expect(reasoningSpend(latest, "anthropic_budget")).toEqual({
      spent: 1500,
      budget: 8192,
      level: "medium",
      estimated: true,
    });
  });
  it("null without a control, a budget (none) or with budget 0 (Off)", () => {
    expect(reasoningSpend(latest, null)).toBeNull();
    expect(reasoningSpend(latest, "none")).toBeNull();
    expect(reasoningSpend({ ...latest, level: "off" }, "reasoning_effort")).toBeNull();
  });
});

describe("lastRunLine (KOBE-584)", () => {
  it("<spent> of <budget> at <Level> for the latest run", () => {
    expect(lastRunLine(usage("newest", ...RUNS), null, "reasoning_effort")).toBe(
      "1.5k of 8k at Medium",
    );
  });

  it("≈ when the run's count is estimated", () => {
    const u = usage("a", {
      runId: "a",
      reasoningTokens: 640,
      reasoningEstimated: true,
      thinkingLevel: "low",
    });
    expect(lastRunLine(u, null, "anthropic_budget")).toBe("≈640 of 2k at Low");
  });

  it("— with no control, a control without budgets, or budget 0", () => {
    expect(lastRunLine(usage("newest", ...RUNS), null, null)).toBe("—");
    expect(lastRunLine(usage("newest", ...RUNS), null, "none")).toBe("—");
    const off = usage("a", { runId: "a", reasoningTokens: 0, thinkingLevel: "off" });
    expect(lastRunLine(off, null, "reasoning_effort")).toBe("—");
  });

  it("— with no count or no level, and while the live run's usage has not landed", () => {
    expect(
      lastRunLine(usage("a", { runId: "a", thinkingLevel: "high" }), null, "gemini_budget"),
    ).toBe("—");
    expect(lastRunLine(usage("a", { runId: "a", reasoningTokens: 9 }), null, "gemini_budget")).toBe(
      "—",
    );
    expect(lastRunLine(usage("newest", ...RUNS), "live-run", "reasoning_effort")).toBe("—");
    expect(lastRunLine(null, null, "reasoning_effort")).toBe("—");
  });
});

describe("thinkingControl", () => {
  const models = {
    default: "fast",
    models: [
      { alias: "fast", enabled: true, thinkingInTeam: { control: "reasoning_effort" } },
      { alias: "deep", enabled: true, thinkingInTeam: { control: "anthropic_budget" } },
      { alias: "gone", enabled: false, thinkingInTeam: { control: "gemini_budget" } },
      { alias: "old", enabled: true, thinkingInTeam: {} },
    ],
  } as unknown as TeamModels;
  it("the conversation model's control; the team default for null; null when unknown", () => {
    expect(thinkingControl(models, "deep")).toBe("anthropic_budget");
    expect(thinkingControl(models, null)).toBe("reasoning_effort");
    expect(thinkingControl(models, "gone")).toBeNull();
    expect(thinkingControl(models, "old")).toBeNull();
    expect(thinkingControl(models, "missing")).toBeNull();
  });
});

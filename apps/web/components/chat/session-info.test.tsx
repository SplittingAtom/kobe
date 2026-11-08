import { describe, expect, it } from "vitest";
import type { TeamModel, TeamModels } from "../../lib/admin/api/team/models";
import type { LatestCall, RunUsage, ThreadUsage } from "../../lib/admin/api/usage";
import {
  lastRun,
  latestReasoning,
  pendingRunId,
  runControl,
  thinkingTokensLine,
} from "./session-reasoning";

/**
 * KOBE-584: Session info's reasoning rows. "Thinking tokens" sums the runs' KOBE-557 reasoning
 * tokens; "Last run" is the thread's latest run, graded against a budget only when its model's
 * control sends one.
 */
function run(r: Partial<RunUsage>): RunUsage {
  return {
    runId: "r",
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
  };
}

function call(runId: string, model = "gw/effort-model"): LatestCall {
  return {
    runId,
    model,
    at: "2026-11-08T10:00:00Z",
    inputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function usage(latestCall: LatestCall | null, ...runs: Partial<RunUsage>[]): ThreadUsage {
  return { threadId: "t1", latestCall, runs: runs.map(run) };
}

function teamModel(alias: string, gatewayModel: string, m: Partial<TeamModel> = {}): TeamModel {
  return {
    alias,
    gatewayModel,
    providerId: "gw",
    model: alias,
    label: null,
    inputModalities: ["text"],
    maxOutputTokens: null,
    contextWindow: null,
    reasoning: true,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    enabled: true,
    isDefault: false,
    ...m,
  };
}

const MODELS: TeamModels = {
  default: "effort",
  models: [
    teamModel("effort", "gw/effort-model", {
      thinkingInTeam: { control: "reasoning_effort", default: "low", levels: ["low", "medium"] },
    }),
    teamModel("budget", "gw/budget-model", {
      thinkingInTeam: { control: "anthropic_budget", default: "low", levels: ["low", "medium"] },
    }),
    teamModel("gemini", "gw/gemini-model", {
      enabled: false,
      thinking: {
        control: "gemini_budget",
        allowed: true,
        default: null,
        max: null,
        lowest: "off",
      },
    }),
  ],
};

const RUNS: Partial<RunUsage>[] = [
  { runId: "older", reasoningTokens: 100, thinkingLevel: "low" },
  { runId: "newest", reasoningTokens: 1500, thinkingLevel: "medium" },
];

describe("thinkingTokensLine (KOBE-584)", () => {
  it("— when no run has a count", () => {
    expect(thinkingTokensLine([])).toBe("—");
    expect(thinkingTokensLine([run({ reasoningTokens: null }), run({})])).toBe("—");
  });

  it("sums the counted runs; null runs contribute nothing", () => {
    const runs = [
      run({ reasoningTokens: 1200 }),
      run({ reasoningTokens: null }),
      run({ reasoningTokens: 300 }),
    ];
    expect(thinkingTokensLine(runs)).toBe("1.5k");
  });

  it("a counted 0 is a count, not unknown", () => {
    expect(thinkingTokensLine([run({ reasoningTokens: 0 })])).toBe("0");
  });

  it("≈ when any counted run is estimated; an uncounted estimated flag does not", () => {
    const runs = [
      run({ reasoningTokens: 800 }),
      run({ reasoningTokens: 40, reasoningEstimated: true }),
    ];
    expect(thinkingTokensLine(runs)).toBe("≈840");
    const uncounted = [
      run({ reasoningTokens: 800 }),
      run({ reasoningTokens: null, reasoningEstimated: true }),
    ];
    expect(thinkingTokensLine(uncounted)).toBe("800");
  });
});

describe("pendingRunId: the live run hides the row only while its usage can still land", () => {
  it("none without a live run", () => {
    expect(pendingRunId(undefined, null)).toBeNull();
  });
  it("the live run while it is open", () => {
    expect(pendingRunId({ runId: "live" }, null)).toBe("live");
    expect(pendingRunId({ runId: "live" }, "live")).toBe("live");
  });
  it("an ended run until the usage read after it lands, then none", () => {
    expect(pendingRunId({ runId: "live", terminal: {} }, "older")).toBe("live");
    expect(pendingRunId({ runId: "live", terminal: {} }, "live")).toBeNull();
  });
});

describe("latestReasoning (KOBE-556, reused by KOBE-584)", () => {
  it("picks the run of the newest call, not the last array entry, with that call's model", () => {
    expect(latestReasoning(usage(call("older", "gw/budget-model"), ...RUNS), null)).toEqual({
      runId: "older",
      model: "gw/budget-model",
      spent: 100,
      level: "low",
      estimated: false,
    });
  });

  it("excludes the pending live run until its usage lands", () => {
    expect(latestReasoning(usage(call("newest"), ...RUNS), "just-started")).toBeNull();
    expect(latestReasoning(usage(call("newest"), ...RUNS), "newest")).toMatchObject({
      spent: 1500,
    });
  });

  it("nothing without a read, a call, reasoning tokens or a recorded level", () => {
    expect(latestReasoning(null, null)).toBeNull();
    expect(latestReasoning(usage(null, ...RUNS), null)).toBeNull();
    expect(
      latestReasoning(usage(call("a"), { runId: "a", reasoningTokens: null }), null),
    ).toBeNull();
    expect(
      latestReasoning(
        usage(call("a"), { runId: "a", reasoningTokens: 5, thinkingLevel: null }),
        null,
      ),
    ).toBeNull();
  });
});

describe("runControl: the control of the model the run used", () => {
  it("by gateway model, the team setting first, the site policy for a disabled model", () => {
    expect(runControl(MODELS, "gw/budget-model")).toBe("anthropic_budget");
    expect(runControl(MODELS, "gw/effort-model")).toBe("reasoning_effort");
    expect(runControl(MODELS, "gw/gemini-model")).toBe("gemini_budget");
  });
  it("null when the run's model is not in the team's list", () => {
    expect(runControl(MODELS, "gw/removed")).toBeNull();
  });
});

describe("lastRun (KOBE-584)", () => {
  it("<spent> of <budget> at <Level> for a budget control (a real request field)", () => {
    const u = usage(call("newest", "gw/budget-model"), ...RUNS);
    expect(lastRun(u, null, MODELS)).toEqual({ value: "1.5k of 8.2k at Medium" });
    const g = usage(call("g", "gw/gemini-model"), {
      runId: "g",
      reasoningTokens: 640,
      reasoningEstimated: true,
      thinkingLevel: "low",
    });
    expect(lastRun(g, null, MODELS)).toEqual({ value: "≈640 of 1k at Low" });
  });

  it("<spent> at <Level> with the typical scale as a title for an effort control", () => {
    const u = usage(call("newest", "gw/effort-model"), ...RUNS);
    expect(lastRun(u, null, MODELS)).toEqual({
      value: "1.5k at Medium",
      title: "Level Medium is a typical scale of about 8k tokens, not a limit",
    });
  });

  it("graded with the run's model, not the conversation's current one", () => {
    const u = usage(call("older", "gw/budget-model"), ...RUNS);
    expect(lastRun(u, null, MODELS)).toEqual({ value: "100 of 2k at Low" });
  });

  it("<spent> at <Level> when the run's model cannot be mapped or the list is not loaded", () => {
    const u = usage(call("newest", "gw/removed"), ...RUNS);
    expect(lastRun(u, null, MODELS)).toEqual({ value: "1.5k at Medium" });
    expect(lastRun(usage(call("newest", "gw/budget-model"), ...RUNS), null, null)).toEqual({
      value: "1.5k at Medium",
    });
  });

  it("a counted run at Off shows its spend at Off, never —", () => {
    const off = (model: string) =>
      usage(call("a", model), {
        runId: "a",
        reasoningTokens: 12,
        reasoningEstimated: true,
        thinkingLevel: "off",
      });
    expect(lastRun(off("gw/budget-model"), null, MODELS)).toEqual({ value: "≈12 at Off" });
    expect(lastRun(off("gw/effort-model"), null, MODELS)).toEqual({ value: "≈12 at Off" });
  });

  it("— with no count or no level, and while the live run's usage has not landed", () => {
    const m = "gw/budget-model";
    expect(
      lastRun(usage(call("a", m), { runId: "a", thinkingLevel: "high" }), null, MODELS),
    ).toEqual({ value: "—" });
    expect(lastRun(usage(call("a", m), { runId: "a", reasoningTokens: 9 }), null, MODELS)).toEqual({
      value: "—",
    });
    expect(lastRun(usage(call("newest", m), ...RUNS), "live-run", MODELS)).toEqual({ value: "—" });
    expect(lastRun(null, null, MODELS)).toEqual({ value: "—" });
  });
});

"use client";

import type { ThinkingLevel } from "@kobe/protocol";
import type { RunUsage, ThreadUsage } from "../../lib/admin/api/usage";
import { useKobeExtras } from "./kobe-runtime";
import { useThreadUsageRead } from "./message-footer";

// TODO(KOBE-557): KOBE-557 adds `RunUsage.reasoningTokens` / `reasoningEstimated`
// (apps/web/lib/admin/api/usage.ts, from `GET /v1/threads/{id}/usage`) and, in @kobe/protocol
// thinking.ts, `thinkingBudget(control, level)` and `THINKING_EFFORT_BUDGETS`. Until this branch
// is rebased onto it, the run's fields are read through the local type below and the budget is
// unknown (`levelBudget` returns undefined), so the readout and bar stay hidden.
type RunReasoning = RunUsage & {
  readonly reasoningTokens?: number | null;
  readonly reasoningEstimated?: boolean;
};

/** The budget of the level a run ran with; unknown until KOBE-557's `thinkingBudget` lands. */
function levelBudget(_level: ThinkingLevel): number | undefined {
  return undefined;
}

/** The latest run's reasoning: what it spent at the level it ran with. */
export interface LatestReasoning {
  readonly runId: string;
  readonly spent: number;
  readonly level: ThinkingLevel;
  readonly estimated: boolean;
}

/**
 * The thread's latest run, chosen by the newest call's time (`latestCall`, the only timestamp the
 * usage read carries; the runs array is ordered by first call, not by recency), with its reasoning
 * tokens and recorded level. Null when the read has no call, when the run streamed in this tab
 * (`liveRunId`) is not that run yet (its usage hasn't landed: never describe the previous run),
 * or when the run reports no reasoning tokens or ran without a thinking level.
 */
export function latestReasoning(
  usage: ThreadUsage | null,
  liveRunId: string | null,
): LatestReasoning | null {
  const newest = usage?.latestCall?.runId;
  if (newest === undefined) return null;
  if (liveRunId !== null && liveRunId !== newest) return null;
  const run = usage?.runs.find((r) => r.runId === newest) as RunReasoning | undefined;
  const spent = run?.reasoningTokens;
  const level = run?.thinkingLevel;
  if (run === undefined || spent == null || level == null) return null;
  return { runId: run.runId, spent, level, estimated: run.reasoningEstimated === true };
}

/** What the Reasoning effort readout shows; empty when the spend or the budget is unknown. */
export interface ReasoningSpend {
  readonly spent?: number;
  readonly budget?: number;
  readonly estimated?: boolean;
}

/**
 * "spent / budget" of the latest run, graded against the budget of the level that run ran with
 * (not the level the pills show: those are about the next run). Empty when either is unknown.
 */
export function reasoningSpend(
  latest: LatestReasoning | null,
  budgetOf: (level: ThinkingLevel) => number | undefined = levelBudget,
): ReasoningSpend {
  if (latest === null) return {};
  const budget = budgetOf(latest.level);
  if (budget === undefined) return {};
  return { spent: latest.spent, budget, estimated: latest.estimated };
}

/** {@link reasoningSpend} for the open thread (its usage read, KOBE-208); empty outside one. */
export function useReasoningSpend(): ReasoningSpend {
  const usage = useThreadUsageRead()?.usage ?? null;
  const liveRunId = useKobeExtras()?.state.live?.runId ?? null;
  return reasoningSpend(latestReasoning(usage, liveRunId));
}

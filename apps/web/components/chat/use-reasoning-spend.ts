"use client";

import { thinkingBudget, type ThinkingControl, type ThinkingLevel } from "@kobe/protocol";
import type { ThreadUsage } from "../../lib/admin/api/usage";
import { useKobeExtras } from "./kobe-runtime";
import { useThreadUsageRead } from "./message-footer";

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
  const run = usage?.runs.find((r) => r.runId === newest);
  const spent = run?.reasoningTokens ?? null;
  const level = run?.thinkingLevel ?? null;
  if (run === undefined || spent === null || level === null) return null;
  return { runId: run.runId, spent, level, estimated: run.reasoningEstimated ?? false };
}

/** What the Reasoning effort readout shows; empty when the spend or the budget is unknown. */
export interface ReasoningSpend {
  readonly spent?: number;
  readonly budget?: number;
  readonly estimated?: boolean;
}

/**
 * "spent / budget" of the latest run, graded against the budget of the level that run ran with
 * (not the level the pills show: those are about the next run), in the form the model's control
 * writes it (KOBE-557 `thinkingBudget`). Empty when the spend, the control (no control, or an
 * older server) or the budget is unknown.
 */
export function reasoningSpend(
  latest: LatestReasoning | null,
  control: ThinkingControl | null,
): ReasoningSpend {
  if (latest === null || control === null) return {};
  const budget = thinkingBudget(control, latest.level);
  if (budget === null) return {};
  return { spent: latest.spent, budget, estimated: latest.estimated };
}

/**
 * {@link reasoningSpend} for the open thread (its usage read, KOBE-208) with the conversation's
 * model's `control`; empty outside a thread.
 */
export function useReasoningSpend(control: ThinkingControl | null): ReasoningSpend {
  const usage = useThreadUsageRead()?.usage ?? null;
  const liveRunId = useKobeExtras()?.state.live?.runId ?? null;
  return reasoningSpend(latestReasoning(usage, liveRunId), control);
}

import { thinkingBudget, type ThinkingControl, type ThinkingLevel } from "@kobe/protocol";
import type { TeamModels } from "../../lib/admin/api/team/models";
import type { RunUsage, ThreadUsage } from "../../lib/admin/api/usage";
import { formatTokens } from "../../lib/admin/usage-format";

/**
 * Session info's reasoning rows (KOBE-584): the KOBE-557 reasoning tokens of the thread's runs,
 * and the latest run graded against its level's budget. Plain functions; the helpers were the
 * composer readout's (KOBE-556, removed by KOBE-574).
 */

const LEVEL_NAMES: Readonly<Record<ThinkingLevel, string>> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** The control of the conversation's model (`alias`, null: the team default); null when unknown. */
export function thinkingControl(models: TeamModels, alias: string | null): ThinkingControl | null {
  const model = models.models.find((m) => m.alias === (alias ?? models.default));
  return (model?.enabled ? model.thinkingInTeam?.control : undefined) ?? null;
}

/** The runs' reasoning tokens: the sum over runs with a count (null: none had one). */
export interface ReasoningTotal {
  readonly tokens: number | null;
  readonly estimated: boolean;
}

export function reasoningTotal(
  runs: readonly Pick<RunUsage, "reasoningTokens" | "reasoningEstimated">[],
): ReasoningTotal {
  return runs.reduce<ReasoningTotal>(
    (acc, r) =>
      r.reasoningTokens === null || r.reasoningTokens === undefined
        ? acc
        : {
            tokens: (acc.tokens ?? 0) + r.reasoningTokens,
            estimated: acc.estimated || r.reasoningEstimated === true,
          },
    { tokens: null, estimated: false },
  );
}

/** "Thinking tokens": the sum, ≈ when any counted run was estimated, "—" when none had a count. */
export function thinkingTokensLine(
  runs: readonly Pick<RunUsage, "reasoningTokens" | "reasoningEstimated">[],
): string {
  const { tokens, estimated } = reasoningTotal(runs);
  return tokens === null ? "—" : `${estimated ? "≈" : ""}${formatTokens(tokens)}`;
}

/** The latest run's reasoning: what it spent at the level it ran with. */
export interface LatestReasoning {
  readonly runId: string;
  readonly spent: number;
  readonly level: ThinkingLevel;
  readonly estimated: boolean;
}

/**
 * The thread's latest run, chosen by the newest call's time (`latestCall`; the runs array is
 * ordered by first call, not by recency). Null without a call, while the run streamed in this tab
 * (`liveRunId`) is not that run yet (its usage hasn't landed: never describe the previous run), or
 * when the run has no reasoning count or no thinking level.
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

/** The latest run's spend against its level's budget. */
export interface ReasoningSpend {
  readonly spent: number;
  readonly budget: number;
  readonly level: ThinkingLevel;
  readonly estimated: boolean;
}

/**
 * The latest run graded against the budget of the level it ran with, in the form the model's
 * control writes it (KOBE-557 `thinkingBudget`). Null when the spend or the control is unknown,
 * the control has no budgets, or the budget is 0 (Off).
 */
export function reasoningSpend(
  latest: LatestReasoning | null,
  control: ThinkingControl | null,
): ReasoningSpend | null {
  if (latest === null || control === null) return null;
  const budget = thinkingBudget(control, latest.level);
  if (budget === null || budget === 0) return null;
  return { spent: latest.spent, budget, level: latest.level, estimated: latest.estimated };
}

/** "Last run": "<spent> of <budget> at <Level>", ≈ when estimated, "—" when unknown. */
export function lastRunLine(
  usage: ThreadUsage | null,
  liveRunId: string | null,
  control: ThinkingControl | null,
): string {
  const spend = reasoningSpend(latestReasoning(usage, liveRunId), control);
  if (spend === null) return "—";
  const spent = `${spend.estimated ? "≈" : ""}${formatTokens(spend.spent)}`;
  return `${spent} of ${formatTokens(spend.budget)} at ${LEVEL_NAMES[spend.level]}`;
}

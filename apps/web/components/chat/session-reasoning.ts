import {
  THINKING_EFFORT_BUDGETS,
  thinkingBudget,
  type ThinkingControl,
  type ThinkingLevel,
} from "@kobe/protocol";
import type { TeamModels } from "../../lib/admin/api/team/models";
import type { RunUsage, ThreadUsage } from "../../lib/admin/api/usage";
import { formatTokens } from "../../lib/admin/usage-format";
import { EFFORT_LABELS } from "./thinking-picker";

/**
 * Session info's reasoning rows (KOBE-584): the KOBE-557 reasoning tokens of the thread's runs,
 * and the latest run's spend at its level. Plain functions; some were the composer readout's
 * (KOBE-556, removed by KOBE-574).
 */

/** Controls whose level sets a token budget the request carries (the rest send an effort). */
const BUDGET_CONTROLS: ReadonlySet<ThinkingControl> = new Set([
  "anthropic_budget",
  "gemini_budget",
]);
/** Controls that send an effort: their budget is a display scale, not a limit. */
const EFFORT_CONTROLS: ReadonlySet<ThinkingControl> = new Set([
  "reasoning_effort",
  "anthropic_adaptive",
  "anthropic_effort",
]);

/**
 * The control of the model a run used (`gatewayModel`, as its calls named it): the team's setting,
 * else the site policy (a model the team has since disabled). Null when the team's list has no
 * such model.
 */
export function runControl(models: TeamModels, gatewayModel: string): ThinkingControl | null {
  const model = models.models.find((m) => m.gatewayModel === gatewayModel);
  return model?.thinkingInTeam?.control ?? model?.thinking?.control ?? null;
}

/**
 * The run streamed in this tab whose usage may not have landed yet: while it is open, and after it
 * ended until the usage read that waited for it (`afterRun`) arrived. Null otherwise, so a run
 * that ended without a model call does not hide the previous one.
 */
export function pendingRunId(
  live: { readonly runId: string; readonly terminal?: unknown } | undefined,
  afterRun: string | null,
): string | null {
  if (live === undefined) return null;
  return live.terminal === undefined || afterRun !== live.runId ? live.runId : null;
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
  /** The model of the run's newest call (`<gateway provider>/<model>`). */
  readonly model: string;
  readonly spent: number;
  readonly level: ThinkingLevel;
  readonly estimated: boolean;
}

/**
 * The thread's latest run, chosen by the newest call's time (`latestCall`; the runs array is
 * ordered by first call, not by recency). Null without a call, while the pending live run
 * ({@link pendingRunId}) is not that run yet (never describe the previous run), or when the run
 * has no reasoning count or no thinking level.
 */
export function latestReasoning(
  usage: ThreadUsage | null,
  pending: string | null,
): LatestReasoning | null {
  const call = usage?.latestCall ?? null;
  if (call === null) return null;
  const newest = call.runId;
  if (pending !== null && pending !== newest) return null;
  const run = usage?.runs.find((r) => r.runId === newest);
  const spent = run?.reasoningTokens ?? null;
  const level = run?.thinkingLevel ?? null;
  if (run === undefined || spent === null || level === null) return null;
  return {
    runId: run.runId,
    model: call.model,
    spent,
    level,
    estimated: run.reasoningEstimated ?? false,
  };
}

/** A Session info value with an optional tooltip. */
export interface Line {
  readonly value: string;
  readonly title?: string;
}

/**
 * "Last run": "<spent> of <budget> at <Level>" when the run's model sends a token budget
 * (anthropic_budget, gemini_budget) above 0; otherwise "<spent> at <Level>", with the effort
 * controls' typical scale as the title. Graded with the control of the model the run used, not
 * the conversation's current one. "—" without a count or a level.
 */
export function lastRun(
  usage: ThreadUsage | null,
  pending: string | null,
  models: TeamModels | null,
): Line {
  const latest = latestReasoning(usage, pending);
  if (latest === null) return { value: "—" };
  const { level } = latest;
  const spentAt = `${latest.estimated ? "≈" : ""}${formatTokens(latest.spent)}`;
  const at = `at ${EFFORT_LABELS[level]}`;
  const control = models === null ? null : runControl(models, latest.model);
  if (control === null || level === "off") return { value: `${spentAt} ${at}` };
  const budget = thinkingBudget(control, level);
  if (BUDGET_CONTROLS.has(control) && budget !== null && budget > 0) {
    return { value: `${spentAt} of ${formatTokens(budget)} ${at}` };
  }
  if (EFFORT_CONTROLS.has(control)) {
    const scale = formatTokens(THINKING_EFFORT_BUDGETS[level]);
    return {
      value: `${spentAt} ${at}`,
      title: `Level ${EFFORT_LABELS[level]} is a typical scale of about ${scale} tokens, not a limit`,
    };
  }
  return { value: `${spentAt} ${at}` };
}

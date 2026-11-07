"use client";

import type { ThinkingLevel } from "@kobe/protocol";
import type { RunUsage, ThreadUsage } from "../../lib/admin/api/usage";
import { useThreadUsageRead } from "./message-footer";

// TODO(KOBE-557): KOBE-557 adds these to main: `RunUsage.reasoningTokens` / `reasoningEstimated`
// (apps/web/lib/admin/api/usage.ts, from `GET /v1/threads/{id}/usage`) and, in @kobe/protocol
// thinking.ts, `THINKING_EFFORT_BUDGETS` and `thinkingBudget(control, level)`. Until it lands,
// the local type and table below stand in under those exact names; replace both with the real
// imports (and `thinkingBudget` with the model's control once the team models carry it).
type RunReasoning = RunUsage & {
  readonly reasoningTokens?: number | null;
  readonly reasoningEstimated?: boolean;
};
const THINKING_EFFORT_BUDGETS: Readonly<Record<ThinkingLevel, number>> = {
  off: 0,
  low: 2000,
  medium: 8000,
  high: 24000,
};

/** What the Reasoning effort readout shows; empty when the spend or the budget is unknown. */
export interface ReasoningSpend {
  readonly spent?: number;
  readonly budget?: number;
  readonly estimated?: boolean;
}

/**
 * The thread's latest run's reasoning tokens against the budget of `level` (the level the
 * control shows: the choice as runs get it, else the default). Empty when either is unknown.
 */
export function reasoningSpend(
  usage: ThreadUsage | null,
  level: ThinkingLevel | null,
): ReasoningSpend {
  const run = usage?.runs.at(-1) as RunReasoning | undefined;
  const spent = run?.reasoningTokens;
  if (spent == null || level === null) return {};
  return {
    spent,
    budget: THINKING_EFFORT_BUDGETS[level],
    estimated: run?.reasoningEstimated === true,
  };
}

/** {@link reasoningSpend} for the open thread (its usage read, KOBE-208); empty outside one. */
export function useReasoningSpend(level: ThinkingLevel | null): ReasoningSpend {
  return reasoningSpend(useThreadUsageRead()?.usage ?? null, level);
}

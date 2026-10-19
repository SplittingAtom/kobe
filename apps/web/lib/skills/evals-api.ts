/**
 * Skill evals over the API (KOBE-325, KOBE-327; contract `@kobe/protocol` skill-evals `api.ts`):
 * the estimate before Run and the start. Responses arrive camelized.
 */
import { apiRequest, type ApiResult } from "../api/client";

export type EvalMode = "full" | "with_only";

/** "≈ $X, ≈ N min" (SK18): null numbers with `basis: none` when the team has no history. */
export interface EvalEstimate {
  readonly executions: number;
  readonly costUsd: number | null;
  readonly minutes: number | null;
  readonly basis: "team_history" | "none";
}

export interface EvalEstimateView {
  readonly estimate: EvalEstimate;
  readonly runModel: {
    readonly requested: string | null;
    readonly used: string;
    readonly fellBack: boolean;
  };
  /** A budget or the team eval cap that would refuse a start now, and why. */
  readonly blocked: { readonly code: string; readonly message: string } | null;
}

const enc = encodeURIComponent;

export function estimateDraftEval(
  teamId: string,
  draftId: string,
  mode: EvalMode,
): Promise<ApiResult<EvalEstimateView>> {
  return apiRequest(`/v1/skills/drafts/${enc(draftId)}/evals/estimate?mode=${mode}`, { teamId });
}

export function startDraftEval(
  teamId: string,
  draftId: string,
  mode: EvalMode,
): Promise<ApiResult<{ readonly evalRunId: string; readonly estimate: EvalEstimate }>> {
  return apiRequest(`/v1/skills/drafts/${enc(draftId)}/evals`, {
    method: "POST",
    json: { mode },
    teamId,
  });
}

/** "≈ $0.42, ≈ 6 min · 8 runs", or what is not known yet. */
export function estimateText(e: EvalEstimate): string {
  const runs = `${e.executions} ${e.executions === 1 ? "run" : "runs"}`;
  if (e.basis === "none")
    return `${runs} · no estimate yet (the team has no history on this model)`;
  const cost =
    e.costUsd === null
      ? "cost unknown (unpriced model)"
      : `≈ $${e.costUsd < 0.01 ? e.costUsd.toFixed(4) : e.costUsd.toFixed(2)}`;
  return `${cost}, ≈ ${e.minutes ?? "?"} min · ${runs}`;
}

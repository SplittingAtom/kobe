/**
 * Skill evals over the API (KOBE-325, KOBE-327; contract `@kobe/protocol` skill-evals `api.ts`):
 * the estimate before Run and the start. Responses arrive camelized.
 */
import type { SkillEvalRunView } from "@kobe/protocol";
import { apiRequest, type ApiResult } from "../api/client";

/** An eval as the API serves it: its costs only for its starter and Team admins. */
export type SkillEvalRun = SkillEvalRunView;

export type EvalMode = "full" | "with_only";

/** "≈ $X, ≈ N min" (SK18): null numbers with `basis: none` when the team has no history. */
export interface EvalEstimate {
  readonly executions: number;
  readonly costUsd: number | null;
  readonly minutes: number | null;
  /** Team admins: the team's history; others: their own; else the suite's sizes (KOBE-327). */
  readonly basis: "team_history" | "own_history" | "suite_size" | "none";
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
  if (e.basis === "none") return `${runs} · no estimate yet (no history or prices for this model)`;
  const cost =
    e.costUsd === null
      ? "cost unknown (unpriced model)"
      : `≈ $${e.costUsd < 0.01 ? e.costUsd.toFixed(4) : e.costUsd.toFixed(2)}`;
  const rough = e.basis === "suite_size" ? " (rough: from the suite's size, no history yet)" : "";
  return `${cost}, ≈ ${e.minutes ?? "?"} min · ${runs}${rough}`;
}

export function getEvalRun(teamId: string, id: string): Promise<ApiResult<SkillEvalRun>> {
  return apiRequest(`/v1/skill-evals/${enc(id)}`, { teamId });
}

/** A draft's eval history, newest first (every revision). */
export async function listDraftEvals(
  teamId: string,
  draftId: string,
): Promise<ApiResult<readonly SkillEvalRun[]>> {
  const res = await apiRequest<{ readonly evals: readonly SkillEvalRun[] }>(
    `/v1/skill-evals?draft_id=${enc(draftId)}`,
    { teamId },
  );
  return res.ok ? { ...res, data: res.data.evals } : res;
}

/** A saved version's skill's eval history, newest first (every version). */
export async function listSkillEvals(
  teamId: string,
  scope: "team" | "personal",
  skillId: string,
): Promise<ApiResult<readonly SkillEvalRun[]>> {
  const res = await apiRequest<{ readonly evals: readonly SkillEvalRun[] }>(
    `/v1/skill-evals?scope=${scope}&skill_id=${enc(skillId)}`,
    { teamId },
  );
  return res.ok ? { ...res, data: res.data.evals } : res;
}

export function cancelEvalRun(teamId: string, id: string): Promise<ApiResult<SkillEvalRun>> {
  return apiRequest(`/v1/skill-evals/${enc(id)}/cancel`, { method: "POST", json: {}, teamId });
}

/** "draft r3" or "v2": which revision or version a run evaluated. */
export function subjectLabel(run: SkillEvalRun): string {
  return run.subject.kind === "draft"
    ? `revision ${run.subject.rev}`
    : `version ${run.subject.seq}`;
}

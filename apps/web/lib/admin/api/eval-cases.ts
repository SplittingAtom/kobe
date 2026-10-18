/**
 * Shared eval cases in the consoles (KOBE-276), camelized from `@kobe/protocol` eval-cases.ts.
 *
 * - The agent's owner lists, reads and reviews the cases shared on their agent
 *   (`/v1/agents/{id}/eval-cases`): never who shared one, and the UTC day only (`sharedOn`).
 *   Everyone else gets 403, team admins who don't own the agent included.
 * - A member lists their own shared cases (`GET /v1/eval-cases`), also once the rating is cleared,
 *   and withdraws one (`DELETE /v1/eval-cases/{id}`: always 204, a legal hold answers the same).
 */
import { EVAL_CASE_EXPECTED_MAX_CHARS, type EvalCaseStatus } from "@kobe/protocol";
import { apiRequest, type ApiResult } from "../../api/client";
import type { EvalCaseContent } from "../../chat/eval-cases";
import type { FeedbackReason } from "../../chat/feedback";

export { EVAL_CASE_EXPECTED_MAX_CHARS, type EvalCaseContent, type EvalCaseStatus };

const enc = encodeURIComponent;

export interface AgentEvalCaseSummary {
  readonly id: string;
  readonly status: EvalCaseStatus;
  readonly agentVersion: number | null;
  readonly reasons: readonly FeedbackReason[];
  readonly promptExcerpt: string;
  /** UTC day the case was shared, `YYYY-MM-DD`: never the time. */
  readonly sharedOn: string;
  readonly expectedBehaviour: string | null;
  readonly reviewedAt: string | null;
}

export interface AgentEvalCases {
  readonly agentId: string;
  readonly accepted: number;
  readonly maxAccepted: number;
  readonly cases: readonly AgentEvalCaseSummary[];
}

export interface AgentEvalCase extends AgentEvalCaseSummary {
  readonly content: EvalCaseContent;
}

/** A change an owner makes: accept, dismiss or reopen, and/or the expected behaviour. */
export interface EvalCaseReview {
  readonly status?: EvalCaseStatus;
  /** null clears it (refused while accepted). */
  readonly expectedBehaviour?: string | null;
}

export const listAgentEvalCases = (
  teamId: string,
  agentId: string,
): Promise<ApiResult<AgentEvalCases>> =>
  apiRequest(`/v1/agents/${enc(agentId)}/eval-cases`, { teamId });

export const getAgentEvalCase = (
  teamId: string,
  agentId: string,
  caseId: string,
): Promise<ApiResult<AgentEvalCase>> =>
  apiRequest(`/v1/agents/${enc(agentId)}/eval-cases/${enc(caseId)}`, { teamId });

export const reviewAgentEvalCase = (
  teamId: string,
  agentId: string,
  caseId: string,
  review: EvalCaseReview,
): Promise<ApiResult<AgentEvalCase>> =>
  apiRequest(`/v1/agents/${enc(agentId)}/eval-cases/${enc(caseId)}`, {
    method: "PATCH",
    teamId,
    json: {
      ...(review.status !== undefined ? { status: review.status } : {}),
      ...(review.expectedBehaviour !== undefined
        ? { expected_behaviour: review.expectedBehaviour }
        : {}),
    },
  });

/** A member's own shared case. */
export interface MySharedCase {
  readonly id: string;
  readonly agent: {
    readonly scope: "team" | "personal";
    readonly id: string;
    readonly version: number | null;
  };
  readonly status: EvalCaseStatus;
  readonly content: EvalCaseContent;
  readonly sharedAt: string;
}

export async function listMySharedCases(
  teamId: string,
): Promise<ApiResult<readonly MySharedCase[]>> {
  const res = await apiRequest<{ cases: MySharedCase[] }>("/v1/eval-cases", { teamId });
  return res.ok ? { ...res, data: res.data.cases } : res;
}

export const withdrawSharedCase = (teamId: string, caseId: string): Promise<ApiResult<void>> =>
  apiRequest(`/v1/eval-cases/${enc(caseId)}`, { method: "DELETE", teamId });

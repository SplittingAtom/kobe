/**
 * The author's submissions to the Site Skills Registry and what reviewers sent back (KOBE-334,
 * SK23): `GET /v1/me/skill-submissions`. Responses arrive camelized.
 */
import { apiRequest, type ApiResult } from "../api/client";

export interface SubmissionNote {
  readonly action: string;
  readonly note: string;
  readonly at: string;
}

export interface Submission {
  readonly id: string;
  readonly name: string;
  readonly semver: string;
  readonly state: string;
  readonly submittedAt: string;
  readonly updatedAt: string;
  /** Approved by its submitter or confirming Team admin on a single-admin Site (SK22). */
  readonly selfApproved: boolean;
  readonly notes: readonly SubmissionNote[];
}

export function listMySubmissions(): Promise<ApiResult<{ submissions: Submission[] }>> {
  return apiRequest("/v1/me/skill-submissions");
}

/** Takes a submission back before a decision (KOBE-334 review M3). */
export function retractSubmission(id: string): Promise<ApiResult<{ id: string; state: string }>> {
  return apiRequest(`/v1/me/skill-submissions/${encodeURIComponent(id)}/retract`, {
    method: "POST",
    json: {},
  });
}

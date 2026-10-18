/** Team console: skill review queue and personal-skills switch (`/v1/team/skill-review`, KOBE-80). */
import { apiRequest, type ApiResult } from "../../../api/client";

const BASE = "/v1/team/skill-review";
const enc = encodeURIComponent;

export type ReviewStatus = "pending" | "approved" | "rejected";
export type ReviewFilter = ReviewStatus;

export interface SkillFinding {
  readonly category: string;
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly excerpt: string;
}

export interface SkillReview {
  readonly skillId: string;
  readonly slug: string;
  readonly version: number;
  /** MAJOR.MINOR.PATCH (KOBE-308): what the UI shows; `version` addresses the API. */
  readonly semver: string;
  readonly contentHash: string;
  /** `personal`: a member's personal skill that needs this team's approval. */
  readonly scope: "team" | "personal";
  /** Not scanned yet (older version): findings are filled in when the queue is listed. */
  readonly unscanned: boolean;
  readonly status: ReviewStatus;
  readonly flagged: boolean;
  /** Scan tier (KOBE-312): Caution findings need acknowledging; Block needs a Site admin. */
  readonly verdict: "pass" | "caution" | "block";
  /** Sent back as `acknowledgedFindings` to approve exactly the findings shown (KOBE-312). */
  readonly findingsDigest: string;
  readonly findings: readonly SkillFinding[];
  readonly scripts: readonly string[];
  readonly skipped: readonly string[];
  readonly scannedAt: string;
  /** The bundle hash is on the site blocklist: approving is refused. */
  readonly blocked: boolean;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly reviewNote: string | null;
}

export async function listSkillReviews(
  teamId: string,
  status: ReviewFilter,
): Promise<ApiResult<readonly SkillReview[]>> {
  const res = await apiRequest<{ reviews: SkillReview[] }>(`${BASE}?status=${enc(status)}`, {
    teamId,
  });
  return res.ok ? { ...res, data: res.data.reviews } : res;
}

export async function decideSkillReview(
  teamId: string,
  review: Pick<SkillReview, "skillId" | "version">,
  decision: "approved" | "rejected",
  options: { readonly acknowledgedFindings?: string; readonly note?: string } = {},
): Promise<ApiResult<SkillReview>> {
  const res = await apiRequest<{ review: SkillReview }>(
    `${BASE}/${enc(review.skillId)}/versions/${review.version}`,
    { method: "POST", json: { decision, ...options }, teamId },
  );
  return res.ok ? { ...res, data: res.data.review } : res;
}

export async function getPersonalSkillsDisabled(teamId: string): Promise<ApiResult<boolean>> {
  const res = await apiRequest<{ personalSkillsDisabled: boolean }>(`${BASE}/settings`, {
    teamId,
  });
  return res.ok ? { ...res, data: res.data.personalSkillsDisabled } : res;
}

export async function putPersonalSkillsDisabled(
  teamId: string,
  personalSkillsDisabled: boolean,
): Promise<ApiResult<boolean>> {
  const res = await apiRequest<{ personalSkillsDisabled: boolean }>(`${BASE}/settings`, {
    method: "PUT",
    json: { personalSkillsDisabled },
    teamId,
  });
  return res.ok ? { ...res, data: res.data.personalSkillsDisabled } : res;
}

/** The team's catalog switches (KOBE-316, SK25), both on by default. */
export interface CatalogSwitches {
  readonly membersMayAddCatalog: boolean;
  readonly buildersMayInstallCatalog: boolean;
}

export async function getCatalogSwitches(teamId: string): Promise<ApiResult<CatalogSwitches>> {
  const res = await apiRequest<CatalogSwitches>(`${BASE}/settings`, { teamId });
  return res.ok
    ? {
        ...res,
        data: {
          membersMayAddCatalog: res.data.membersMayAddCatalog,
          buildersMayInstallCatalog: res.data.buildersMayInstallCatalog,
        },
      }
    : res;
}

/** Changes one or both switches (Team admins; audited). */
export function putCatalogSwitches(
  teamId: string,
  change: Partial<CatalogSwitches>,
): Promise<ApiResult<CatalogSwitches>> {
  return apiRequest(`${BASE}/settings`, { method: "PUT", json: change, teamId });
}

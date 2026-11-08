/**
 * Promote to Site (KOBE-333, SK19): the preview of what leaves the team with SK20's rule check,
 * the promotion, and the team's queue of Builders' requests. Responses arrive camelized.
 */
import { apiRequest, type ApiResult } from "../api/client";

export interface PromoteSource {
  readonly scope: "team" | "personal";
  readonly skillId: string;
  readonly version: number;
}

export interface PackageFile {
  readonly path: string;
  readonly size: number;
}

export interface Refusal {
  readonly code: string;
  readonly message: string;
}

export interface PromotionPreview {
  readonly name: string;
  readonly semver: string;
  readonly files: readonly PackageFile[];
  readonly fixtures: readonly PackageFile[];
  readonly fromConversation: boolean;
  readonly newSkill: boolean;
  readonly verdict: string;
  readonly refusals: readonly Refusal[];
}

export type PromoteOutcome =
  | { readonly state: "submitted"; readonly registryVersionId: string }
  | { readonly state: "requested"; readonly requestId: string };

export interface PromotionRequest {
  readonly id: string;
  readonly skillId: string;
  readonly version: number;
  readonly semver: string;
  readonly requestedBy: string;
  readonly createdAt: string;
}

const q = (s: PromoteSource) =>
  `scope=${s.scope}&skillId=${encodeURIComponent(s.skillId)}&version=${s.version}`;

export function previewPromotion(
  teamId: string,
  source: PromoteSource,
): Promise<ApiResult<PromotionPreview>> {
  return apiRequest(`/v1/skills/promotions/preview?${q(source)}`, { teamId });
}

export function promoteVersion(
  teamId: string,
  source: PromoteSource,
): Promise<ApiResult<PromoteOutcome>> {
  return apiRequest("/v1/skills/promotions", { method: "POST", json: source, teamId });
}

/** The author's license for a generated manifest (KOBE-564); `Proprietary` is the contract's own. */
export const MANIFEST_LICENSES = ["Proprietary", "Apache-2.0", "MIT", "BSD-3-Clause"] as const;
export type ManifestLicense = (typeof MANIFEST_LICENSES)[number];

export interface ManifestDraftChoice {
  /** The catalog alias; undefined: the team default. */
  readonly model?: string | undefined;
  readonly license?: ManifestLicense | undefined;
}

export interface ManifestDraft {
  readonly draft: { readonly id: string; readonly name: string; readonly rev: number };
  readonly manifest: { readonly summary: string; readonly tags?: readonly string[] };
  /** The catalog alias that answered. */
  readonly model: string;
  /** `model`: fields from the reply; `seed`: SKILL.md's description alone. */
  readonly source: "model" | "seed";
}

/**
 * Create kobe.skill.yaml for a version without one (KOBE-564): the chosen model drafts it, and
 * the version is forked into a Workbench draft of the caller's with the file in place.
 */
export function createManifestDraft(
  teamId: string,
  source: PromoteSource,
  choice: ManifestDraftChoice,
): Promise<ApiResult<ManifestDraft>> {
  return apiRequest("/v1/skills/promotions/manifest", {
    method: "POST",
    json: {
      ...source,
      ...(choice.model === undefined ? {} : { model: choice.model }),
      ...(choice.license === undefined ? {} : { license: choice.license }),
    },
    teamId,
  });
}

const QUEUE = "/v1/team/skill-promotions";

export async function listPromotionRequests(
  teamId: string,
): Promise<ApiResult<readonly PromotionRequest[]>> {
  const res = await apiRequest<{ requests: PromotionRequest[] }>(QUEUE, { teamId });
  return res.ok ? { ...res, data: res.data.requests } : res;
}

export function getPromotionRequest(
  teamId: string,
  id: string,
): Promise<ApiResult<PromotionPreview & { readonly request: PromotionRequest }>> {
  return apiRequest(`${QUEUE}/${encodeURIComponent(id)}`, { teamId });
}

export function confirmPromotionRequest(
  teamId: string,
  id: string,
): Promise<ApiResult<PromoteOutcome>> {
  return apiRequest(`${QUEUE}/${encodeURIComponent(id)}/confirm`, {
    method: "POST",
    json: {},
    teamId,
  });
}

export function declinePromotionRequest(
  teamId: string,
  id: string,
  note: string,
): Promise<ApiResult<unknown>> {
  return apiRequest(`${QUEUE}/${encodeURIComponent(id)}/decline`, {
    method: "POST",
    json: note.trim() ? { note: note.trim() } : {},
    teamId,
  });
}

/** Team console: skill bundles (`/v1/skills`, KOBE-78/83). Every call names the team. */
import { apiDownload, apiRequest, type ApiResult } from "../../../api/client";

const enc = encodeURIComponent;

export type SkillScope = "team" | "personal";

export interface SkillSummary {
  readonly id: string;
  readonly scope: SkillScope;
  readonly slug: string;
  readonly description: string;
  readonly latestVersion: number;
  readonly ownerUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SkillVersionInfo {
  readonly version: number;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly uploadedAt: string;
}

export interface SkillSaved {
  readonly skill: SkillSummary;
  readonly version: SkillVersionInfo;
}

/** Team and personal skills the caller can see, or only one scope. */
export async function listSkills(
  teamId: string,
  scope?: SkillScope,
): Promise<ApiResult<readonly SkillSummary[]>> {
  const res = await apiRequest<{ skills: SkillSummary[] }>(
    scope ? `/v1/skills?scope=${scope}` : "/v1/skills",
    { teamId },
  );
  return res.ok ? { ...res, data: res.data.skills } : res;
}

export async function getSkill(teamId: string, id: string): Promise<ApiResult<SkillSummary>> {
  const res = await apiRequest<{ skill: SkillSummary }>(`/v1/skills/${enc(id)}`, { teamId });
  return res.ok ? { ...res, data: res.data.skill } : res;
}

export function downloadSkillBundle(
  teamId: string,
  id: string,
  version: number,
): Promise<ApiResult<Uint8Array>> {
  return apiDownload(`/v1/skills/${enc(id)}/versions/${version}/bundle`, { teamId });
}

/** Uploads a zip as the next version of the skill its SKILL.md names. */
export function uploadSkillZip(
  teamId: string,
  scope: SkillScope,
  zip: Uint8Array,
): Promise<ApiResult<SkillSaved>> {
  return apiRequest(`/v1/skills?scope=${scope}`, {
    method: "POST",
    raw: { body: zip, contentType: "application/zip" },
    teamId,
  });
}

/** Team console: skill bundles (`/v1/skills`, KOBE-78/83). Every call names the team. */
import { apiDownload, apiRequest, type ApiResult } from "../../../api/client";

const enc = encodeURIComponent;

export type SkillScope = "team" | "personal";

export interface SkillSummary {
  readonly id: string;
  readonly scope: SkillScope;
  readonly slug: string;
  readonly description: string;
  /** Sequence number of the latest version (paths and downloads use it). */
  readonly latestVersion: number;
  /** MAJOR.MINOR.PATCH of the latest version (KOBE-308): what the UI shows. */
  readonly latestSemver: string;
  readonly ownerUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SkillVersionInfo {
  readonly version: number;
  readonly semver: string;
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

/** An agent a team skill reaches, or one the caller may add it to (KOBE-297). */
export interface SkillReachAgent {
  readonly id: string;
  readonly scope: "team" | "personal" | "gallery";
  readonly slug: string;
  readonly name: string;
  /** How its runs get the skill now: named by its current version, by the offer, or not. */
  readonly via: "named" | "offer" | null;
  readonly exclusive: boolean;
  /** Its draft names the skill (runs get it once that is published). */
  readonly inDraft: boolean;
  readonly canEdit: boolean;
}

/** A team skill's access mode (KOBE-316, SK25). */
export type SkillAccess = "available" | "default_on" | "required" | "hidden";

export interface SkillReach {
  readonly offerToAll: boolean;
  /** On by default and Required reach agents without naming; Required also exclusive ones. */
  readonly access: SkillAccess;
  /** A version is approved: without one no agent gets the skill. */
  readonly approved: boolean;
  readonly agents: readonly SkillReachAgent[];
}

/** Which agents a team skill reaches (`GET /v1/skills/{id}/reach`). */
export function getSkillReach(teamId: string, id: string): Promise<ApiResult<SkillReach>> {
  return apiRequest(`/v1/skills/${enc(id)}/reach`, { teamId });
}

export interface SkillAccessChange {
  readonly access: SkillAccess;
  /** Required team skills and installs now (the console warns from 5). */
  readonly requiredCount: number;
  readonly warning?: "many_required";
}

/** The access mode (Builders; Required is Team admins only). */
export function setSkillAccess(
  teamId: string,
  id: string,
  access: SkillAccess,
): Promise<ApiResult<SkillAccessChange>> {
  return apiRequest(`/v1/skills/${enc(id)}/access`, { method: "PUT", json: { access }, teamId });
}

export interface SkillUsage {
  readonly uses: number;
  readonly lastUsedAt: string | null;
  /** Null id and name: runs with no agent, or an agent the caller can't see. */
  readonly agents: readonly {
    readonly agentId: string | null;
    readonly scope: "team" | "personal" | "gallery" | null;
    readonly name: string | null;
    readonly uses: number;
  }[];
}

/** How often runs in this team used the skill (owners and team admins). */
export function getSkillUsage(teamId: string, id: string): Promise<ApiResult<SkillUsage>> {
  return apiRequest(`/v1/skills/${enc(id)}/usage`, { teamId });
}

/**
 * Team console: the team's catalog installs and Removed defaults (`/v1/team/skills`; KOBE-314,
 * SK6, SK7). Every call names the team.
 */
import { apiRequest, type ApiResult } from "../../../api/client";

const BASE = "/v1/team/skills";
const enc = encodeURIComponent;

export interface CatalogInstall {
  readonly skillId: string;
  readonly name: string;
  readonly versionId: string;
  readonly semver: string;
  readonly pinMode: "pinned" | "within_major" | "latest";
  readonly access: "available" | "default_on" | "required" | "hidden";
  readonly origin: "team" | "default_tag";
  /** Null when Kobe's own Default sync installed it (a Kobe skill, KOBE-317). */
  readonly installedBy: string | null;
  readonly updatedAt: string;
  /** The skill carries the Site's Default tag. */
  readonly isDefault: boolean;
}

export interface RemovedDefault {
  readonly skillId: string;
  readonly name: string;
  readonly optedOutBy: string;
  readonly reason: string | null;
  readonly at: string;
}

export interface TeamSkillInstalls {
  readonly installs: readonly CatalogInstall[];
  readonly removedDefaults: readonly RemovedDefault[];
}

export const OPT_OUT_REASON_MAX = 500;

export function listTeamSkillInstalls(teamId: string): Promise<ApiResult<TeamSkillInstalls>> {
  return apiRequest(`${BASE}/installs`, { teamId });
}

export function uninstallCatalogSkill(
  teamId: string,
  skillId: string,
  reason?: string,
): Promise<ApiResult<{ optedOut: boolean }>> {
  return apiRequest(`${BASE}/installs/${enc(skillId)}`, {
    teamId,
    method: "DELETE",
    json: reason ? { reason } : {},
  });
}

export function reinstallDefault(
  teamId: string,
  skillId: string,
): Promise<ApiResult<{ semver: string }>> {
  return apiRequest(`${BASE}/removed-defaults/${enc(skillId)}/reinstall`, {
    teamId,
    method: "POST",
    json: {},
  });
}

export interface SkillInstallChange {
  readonly version: string;
  readonly pinMode: CatalogInstall["pinMode"];
  readonly access: CatalogInstall["access"];
}

export interface SkillInstallResult {
  readonly semver: string;
  /** The version is deprecated: installed with a warning (SK31). */
  readonly deprecated: boolean;
  /** Required team skills and installs now; the console warns from 5. */
  readonly requiredCount: number;
  readonly warning?: "many_required";
}

/**
 * Installs a catalog skill or changes its install (KOBE-315/316): Team admins, and Builders
 * while the team allows it (never Required, never a deprecated version).
 */
export function putTeamSkillInstall(
  teamId: string,
  skillId: string,
  change: SkillInstallChange,
): Promise<ApiResult<SkillInstallResult>> {
  return apiRequest(`${BASE}/installs/${enc(skillId)}`, { teamId, method: "PUT", json: change });
}

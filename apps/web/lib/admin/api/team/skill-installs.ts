/**
 * Team console: the team's catalog installs and Removed defaults (`/v1/team/skills`; KOBE-314,
 * SK6, SK7). Every call names the team.
 */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { VersionDiff } from "../site/skill-review";

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

/** A newer version of an installed catalog skill (KOBE-337, SK25). */
export interface InstallUpdate {
  readonly versionId: string;
  readonly semver: string;
  readonly changelog: string | null;
  readonly deprecated: boolean;
  /** Another major than what runs now: never taken by Track within major. */
  readonly major: boolean;
  /** The install's pin mode takes it by itself. */
  readonly automatic: boolean;
  readonly evalDelta: { readonly passRate: number | null; readonly lift: number | null };
}

export interface InstallUpdates {
  readonly skillId: string;
  readonly name: string;
  readonly pinMode: CatalogInstall["pinMode"];
  readonly pinned: { readonly versionId: string; readonly semver: string };
  readonly running: { readonly versionId: string; readonly semver: string } | null;
  readonly updates: readonly InstallUpdate[];
  readonly rollbackTo: string | null;
}

export function getInstallUpdates(
  teamId: string,
  skillId: string,
): Promise<ApiResult<InstallUpdates>> {
  return apiRequest(`${BASE}/installs/${enc(skillId)}/updates`, { teamId });
}

export function getInstallDiff(
  teamId: string,
  skillId: string,
  to: string,
): Promise<ApiResult<VersionDiff>> {
  return apiRequest(`${BASE}/installs/${enc(skillId)}/diff?to=${enc(to)}`, { teamId });
}

/** Move pin: the install runs `version` from the next run of every thread (audited). */
export function moveInstallPin(
  teamId: string,
  skillId: string,
  version: string,
): Promise<ApiResult<SkillInstallResult>> {
  return apiRequest(`${BASE}/installs/${enc(skillId)}/move`, {
    teamId,
    method: "POST",
    json: { version },
  });
}

/** Roll back: the install returns to the version it ran before its last change (audited). */
export function rollbackInstall(
  teamId: string,
  skillId: string,
): Promise<ApiResult<SkillInstallResult>> {
  return apiRequest(`${BASE}/installs/${enc(skillId)}/rollback`, {
    teamId,
    method: "POST",
    json: {},
  });
}

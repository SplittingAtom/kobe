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
  /** A Roll back or Move pin back switched it from tracking to Pinned (KOBE-337 review M1). */
  readonly pinnedBy?: "rollback" | "move" | null;
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
  /** The pin mode after the change (Pinned after a move back). */
  readonly pinMode?: CatalogInstall["pinMode"];
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

/** A member's Add for me, as the Team console lists it (KOBE-338, SK25). */
export interface MemberAdd {
  readonly userId: string;
  readonly memberName: string;
  readonly skillId: string;
  readonly name: string;
  readonly semver: string;
  readonly pinMode: "pinned" | "within_major" | "latest";
  /** The version the member's runs load now; null when none can. */
  readonly runs: string | null;
  readonly updatedAt: string;
}

export interface TeamBlock {
  readonly skillId: string;
  readonly name: string;
  readonly blockedBy: string;
  readonly blockedByName: string;
  readonly at: string;
}

export interface InstallRequest {
  readonly skillId: string;
  readonly name: string;
  readonly requesters: readonly { readonly userId: string; readonly name: string }[];
  readonly count: number;
  readonly lastAt: string;
  /** The team's install's version: the members ask for a change. */
  readonly installed?: string | null;
}

export function listMemberAdds(teamId: string): Promise<ApiResult<{ adds: MemberAdd[] }>> {
  return apiRequest(`${BASE}/member-adds`, { teamId });
}

export function listTeamBlocks(teamId: string): Promise<ApiResult<{ blocks: TeamBlock[] }>> {
  return apiRequest(`${BASE}/blocks`, { teamId });
}

export function unblockSkill(teamId: string, skillId: string): Promise<ApiResult<unknown>> {
  return apiRequest(`${BASE}/blocks/${enc(skillId)}`, { teamId, method: "DELETE" });
}

export function listInstallRequests(
  teamId: string,
): Promise<ApiResult<{ requests: InstallRequest[] }>> {
  return apiRequest(`${BASE}/install-requests`, { teamId });
}

export function dismissInstallRequests(
  teamId: string,
  skillId: string,
): Promise<ApiResult<unknown>> {
  return apiRequest(`${BASE}/install-requests/${enc(skillId)}/dismiss`, {
    teamId,
    method: "POST",
    json: {},
  });
}

export type TeamThumbs =
  | { readonly enough: true; readonly up: number; readonly down: number }
  | { readonly enough: false };

/** The team's own usage of one catalog skill in the window (KOBE-339). */
export interface TeamSkillUsage {
  readonly skillId: string;
  readonly name: string;
  /** "few" under three members other than you (KOBE-339 review). */
  readonly runs: number | "few";
  readonly members: number | "few";
  readonly thumbs: TeamThumbs;
  /** Null: withheld (one version would read few). */
  readonly versions:
    | readonly {
        readonly semver: string;
        readonly runs: number | "few";
        readonly members: number | "few";
      }[]
    | null;
  readonly versionThumbs:
    readonly { readonly semver: string; readonly thumbs: TeamThumbs }[] | null;
}

export interface TeamUsage {
  readonly skills: readonly TeamSkillUsage[];
  readonly window: { readonly from: string; readonly to: string };
  readonly refreshedAt: string;
}

export function getTeamSkillUsage(teamId: string): Promise<ApiResult<TeamUsage>> {
  return apiRequest(`${BASE}/usage`, { teamId });
}

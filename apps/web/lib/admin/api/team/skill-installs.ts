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
  readonly installedBy: string;
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

export interface TeamInstalls {
  readonly installs: readonly CatalogInstall[];
  readonly removedDefaults: readonly RemovedDefault[];
}

export const OPT_OUT_REASON_MAX = 500;

export function listTeamInstalls(teamId: string): Promise<ApiResult<TeamInstalls>> {
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

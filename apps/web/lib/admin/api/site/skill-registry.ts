/**
 * Site console: Registry settings (`/v1/site/skills/registry/settings`,
 * site.skills.catalog.manage; KOBE-330, SK20, SK21). Responses arrive camelized.
 */
import type {
  RegistrySettings,
  RegistrySettingsUpdate,
  RegistryTeamCreate,
  SkillMirrorStatus,
} from "@kobe/protocol";
import { apiRequest, type ApiResult } from "../../../api/client";

export type { RegistrySettings, RegistrySettingsUpdate };

const PATH = "/v1/site/skills/registry/settings";

export function getRegistrySettings(): Promise<ApiResult<RegistrySettings>> {
  return apiRequest(PATH);
}

export function putRegistrySettings(
  update: RegistrySettingsUpdate,
): Promise<ApiResult<RegistrySettings>> {
  return apiRequest(PATH, { method: "PUT", json: update });
}

/** Kobe creates the dedicated Registry team (never an existing team; KOBE-330 review). */
export function createRegistryTeam(
  input: RegistryTeamCreate,
): Promise<ApiResult<RegistrySettings>> {
  return apiRequest("/v1/site/skills/registry/team", { method: "POST", json: input });
}

export type { SkillMirrorStatus } from "@kobe/protocol";

const MIRROR_PATH = "/v1/site/skills/registry/mirror";

/** The catalog git mirror's status (KOBE-343): pushed, pending, failing, and what blocks it. */
export function getSkillMirrorStatus(): Promise<ApiResult<SkillMirrorStatus>> {
  return apiRequest(MIRROR_PATH);
}

/** Makes every failed version due now (audited). */
export function retrySkillMirror(): Promise<ApiResult<{ versions: number }>> {
  return apiRequest(`${MIRROR_PATH}/retry`, { method: "POST", json: {} });
}

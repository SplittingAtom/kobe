/**
 * Site console: Registry settings (`/v1/site/skills/registry/settings`,
 * site.skills.catalog.manage; KOBE-330, SK20, SK21). Responses arrive camelized.
 */
import type { RegistrySettings, RegistrySettingsUpdate } from "@kobe/protocol";
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

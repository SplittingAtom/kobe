/** Install console: settings (`/v1/install`, install.settings.manage; turning 2FA off: Owner only). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";

export interface InstallSettings {
  readonly requireTwoFactor: boolean;
}

export function getInstallSettings(): Promise<ApiResult<InstallSettings>> {
  return apiRequest("/v1/install/settings");
}

export function putInstallSettings(settings: InstallSettings): Promise<ApiResult<InstallSettings>> {
  return apiRequest("/v1/install/settings", {
    method: "PUT",
    json: { requireTwoFactor: settings.requireTwoFactor },
  });
}

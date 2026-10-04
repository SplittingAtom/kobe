/** Install console: settings (`/v1/install`, install.settings.manage; turning 2FA off: Owner only). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";

export interface InstallSettings {
  readonly requireTwoFactor: boolean;
  /** Hours audit events keep the client IP and user agent (KOBE-17): 1-8760, default 12. */
  readonly auditPiiRetentionHours?: number;
}

/** Bounds of `auditPiiRetentionHours` (the server validates them again). */
export const AUDIT_PII_RETENTION_HOURS = { min: 1, max: 8760, default: 12 } as const;

/** Sends only the settings given; each change is audited. */
export function putInstallSettings(
  change: Partial<InstallSettings>,
): Promise<ApiResult<InstallSettings>> {
  return apiRequest("/v1/install/settings", { method: "PUT", json: { ...change } });
}

export function getInstallSettings(): Promise<ApiResult<InstallSettings>> {
  return apiRequest("/v1/install/settings");
}

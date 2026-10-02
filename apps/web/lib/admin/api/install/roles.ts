/** Install console: install roles (`/v1/install`, read: install.users.manage; change: Owner only). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";

const enc = encodeURIComponent;

export interface InstallRoleHolder {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: "owner" | "admin";
}

export async function listInstallRoles(): Promise<ApiResult<readonly InstallRoleHolder[]>> {
  const res = await apiRequest<{ roles: InstallRoleHolder[] }>("/v1/install/roles");
  return res.ok ? { ...res, data: res.data.roles } : res;
}

export function setInstallRole(
  userId: string,
  role: "admin" | "user",
): Promise<ApiResult<unknown>> {
  return apiRequest(`/v1/install/roles/${enc(userId)}`, { method: "PUT", json: { role } });
}

export function transferOwnership(userId: string): Promise<ApiResult<unknown>> {
  return apiRequest("/v1/install/roles/transfer-ownership", { method: "POST", json: { userId } });
}

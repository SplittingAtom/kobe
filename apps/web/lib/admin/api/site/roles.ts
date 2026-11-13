/** Site console: site roles (`/v1/site`, read: site.users.manage; change: Owner only). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { SiteGrant } from "../../nav/types";

const enc = encodeURIComponent;

export interface SiteRoleHolder {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: "owner" | "admin";
}

export async function listSiteRoles(): Promise<ApiResult<readonly SiteRoleHolder[]>> {
  const res = await apiRequest<{ roles: SiteRoleHolder[] }>("/v1/site/roles");
  return res.ok ? { ...res, data: res.data.roles } : res;
}

export function setSiteRole(userId: string, role: "admin" | "user"): Promise<ApiResult<unknown>> {
  return apiRequest(`/v1/site/roles/${enc(userId)}`, { method: "PUT", json: { role } });
}

export function transferOwnership(userId: string): Promise<ApiResult<unknown>> {
  return apiRequest("/v1/site/roles/transfer-ownership", { method: "POST", json: { userId } });
}

/** A site grant beside the ladder: Skill reviewer (KOBE-331, SK22) or Site memory steward (KOBE-380). */
export interface SiteGrantHolder {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly grant: SiteGrant;
  readonly grantedBy: string;
  readonly grantedAt: string;
}

export async function listSiteGrants(): Promise<ApiResult<readonly SiteGrantHolder[]>> {
  const res = await apiRequest<{ grants: SiteGrantHolder[] }>("/v1/site/roles/grants");
  return res.ok ? { ...res, data: res.data.grants } : res;
}

export function giveSiteGrant(userId: string, grant: SiteGrant): Promise<ApiResult<unknown>> {
  return apiRequest(`/v1/site/roles/grants/${enc(userId)}/${enc(grant)}`, {
    method: "PUT",
    json: {},
  });
}

export function takeSiteGrant(userId: string, grant: SiteGrant): Promise<ApiResult<unknown>> {
  return apiRequest(`/v1/site/roles/grants/${enc(userId)}/${enc(grant)}`, { method: "DELETE" });
}

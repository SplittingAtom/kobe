/** Site console: site roles (`/v1/site`, read: site.users.manage; change: Owner only). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";

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

/** A site grant beside the ladder (KOBE-331, SK22): today only the Skill reviewer. */
export interface SiteGrantHolder {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly grant: "skill_reviewer";
  readonly grantedBy: string;
  readonly grantedAt: string;
}

export async function listSiteGrants(): Promise<ApiResult<readonly SiteGrantHolder[]>> {
  const res = await apiRequest<{ grants: SiteGrantHolder[] }>("/v1/site/roles/grants");
  return res.ok ? { ...res, data: res.data.grants } : res;
}

export function giveSkillReviewer(userId: string): Promise<ApiResult<unknown>> {
  return apiRequest(`/v1/site/roles/grants/${enc(userId)}/skill_reviewer`, {
    method: "PUT",
    json: {},
  });
}

export function takeSkillReviewer(userId: string): Promise<ApiResult<unknown>> {
  return apiRequest(`/v1/site/roles/grants/${enc(userId)}/skill_reviewer`, { method: "DELETE" });
}

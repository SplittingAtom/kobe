/**
 * Site console: single sign-on access mappings (`/v1/site/sso`, site.users.manage; KOBE-627, spec
 * sso-oidc-scim §7). An IdP value (app role or group id) grants a team role; never a site role.
 */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { TeamRole } from "../../../teams";

const enc = encodeURIComponent;

export interface SsoMappingProvider {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly accessClaim: "roles" | "groups";
  readonly enabled: boolean;
  readonly managedBy: "console" | "helm";
}

export interface SsoMapping {
  readonly id: string;
  readonly providerId: string;
  readonly claimValue: string;
  readonly teamId: string;
  readonly teamSlug: string;
  readonly teamName: string;
  readonly role: TeamRole;
  readonly createdAt: string;
}

export interface SsoMappings {
  readonly providers: readonly SsoMappingProvider[];
  readonly mappings: readonly SsoMapping[];
}

export function listSsoMappings(): Promise<ApiResult<SsoMappings>> {
  return apiRequest<SsoMappings>("/v1/site/sso/mappings");
}

export function createSsoMapping(
  providerId: string,
  input: { readonly claimValue: string; readonly teamId: string; readonly role: TeamRole },
): Promise<ApiResult<{ mapping: SsoMapping }>> {
  return apiRequest(`/v1/site/sso/providers/${enc(providerId)}/mappings`, {
    method: "POST",
    json: input,
  });
}

export function deleteSsoMapping(providerId: string, mappingId: string): Promise<ApiResult<void>> {
  return apiRequest(`/v1/site/sso/providers/${enc(providerId)}/mappings/${enc(mappingId)}`, {
    method: "DELETE",
  });
}

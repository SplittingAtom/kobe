/**
 * Site console: single sign-on providers (`/v1/site/sso/providers`, site.users.manage, KOBE-626).
 * Responses arrive camelized. The client secret is write-only: sent on create or to replace it,
 * never returned (`clientSecret` says only `set` or `missing`).
 */
import { apiRequest, type ApiResult } from "../../../api/client";

const enc = encodeURIComponent;
const BASE = "/v1/site/sso/providers";

export type SsoKind = "entra" | "oidc";

export interface SsoProvider {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly kind: SsoKind;
  readonly issuer: string;
  readonly tenantId: string | null;
  readonly clientId: string;
  readonly subjectClaim: "oid" | "sub";
  readonly accessClaim: "roles" | "groups";
  readonly mfaRule: {
    readonly amrAny: readonly string[];
    readonly acrAny: readonly string[];
    readonly acrsAny: readonly string[];
  };
  readonly allowedEmailDomains: readonly string[];
  readonly jitProvisioning: boolean;
  readonly maxSessionHours: number | null;
  readonly enabled: boolean;
  readonly managedBy: "console" | "helm";
  readonly clientSecret: "set" | "missing";
  readonly redirectUri: string;
  readonly linkedIdentities: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DiscoveryCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly message: string;
}

export interface DiscoveryReport {
  readonly ok: boolean;
  readonly issuer: string | null;
  readonly checks: readonly DiscoveryCheck[];
  readonly failure?: string;
  readonly message?: string;
}

/** Where the provider is: Entra by tenant id, a generic provider by its issuer. */
export type SsoTarget =
  | { readonly kind: "entra"; readonly tenantId: string }
  | { readonly kind: "oidc"; readonly issuer: string };

export type NewSsoProvider = SsoTarget & {
  readonly slug: string;
  readonly displayName: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accessClaim: "roles" | "groups";
};

export interface SsoProviderPatch {
  readonly displayName?: string;
  readonly tenantId?: string;
  readonly issuer?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly accessClaim?: "roles" | "groups";
  readonly enabled?: boolean;
}

export async function listSsoProviders(): Promise<ApiResult<readonly SsoProvider[]>> {
  const res = await apiRequest<{ providers: SsoProvider[] }>(BASE);
  return res.ok ? { ...res, data: res.data.providers } : res;
}

export function createSsoProvider(
  input: NewSsoProvider,
): Promise<ApiResult<{ provider: SsoProvider; discovery: DiscoveryReport }>> {
  return apiRequest(BASE, { method: "POST", json: input });
}

export function updateSsoProvider(
  id: string,
  patch: SsoProviderPatch,
): Promise<ApiResult<{ provider: SsoProvider; discovery?: DiscoveryReport }>> {
  return apiRequest(`${BASE}/${enc(id)}`, { method: "PATCH", json: patch });
}

export function deleteSsoProvider(id: string): Promise<ApiResult<void>> {
  return apiRequest(`${BASE}/${enc(id)}`, { method: "DELETE" });
}

export async function testSsoTarget(target: SsoTarget): Promise<ApiResult<DiscoveryReport>> {
  const res = await apiRequest<{ discovery: DiscoveryReport }>(`${BASE}/test`, {
    method: "POST",
    json: target,
  });
  return res.ok ? { ...res, data: res.data.discovery } : res;
}

export async function testSsoProvider(id: string): Promise<ApiResult<DiscoveryReport>> {
  const res = await apiRequest<{ discovery: DiscoveryReport }>(`${BASE}/${enc(id)}/test`, {
    method: "POST",
  });
  return res.ok ? { ...res, data: res.data.discovery } : res;
}

/** Site console: egress ceiling (`/v1/site/egress-ceiling`, site.egress.manage; KOBE-38). */
import { apiRequest, type ApiResult } from "../../../api/client";

const enc = encodeURIComponent;
const BASE = "/v1/site/egress-ceiling";

export type EgressPreset = "package_registries" | "git_hosts" | "web_search";

export interface CeilingDomain {
  readonly domain: string;
  readonly preset: EgressPreset | null;
  readonly inCeiling: boolean;
  readonly note: string | null;
  /** Shared hosting or a CDN: domain fronting may reach other sites behind it. */
  readonly sharedHosting: boolean;
  /** Same-cluster host: may resolve to the install's internal targets (egress access, EA4). */
  readonly internal: boolean;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EgressCeiling {
  readonly domains: readonly CeilingDomain[];
  readonly presets: readonly EgressPreset[];
}

export function getEgressCeiling(): Promise<ApiResult<EgressCeiling>> {
  return apiRequest(BASE);
}

/** Adds a domain (`example.com` or `*.example.com`); a listed preset domain is put back in. */
export async function addCeilingDomain(
  domain: string,
  note: string | null,
): Promise<ApiResult<CeilingDomain & { readonly warnings: readonly string[] }>> {
  const res = await apiRequest<{ domain: CeilingDomain; warnings?: string[] }>(BASE, {
    method: "POST",
    json: { domain, note },
  });
  return res.ok ? { ...res, data: { ...res.data.domain, warnings: res.data.warnings ?? [] } } : res;
}

export async function setCeilingMembership(
  domain: string,
  inCeiling: boolean,
): Promise<ApiResult<CeilingDomain>> {
  const res = await apiRequest<{ domain: CeilingDomain }>(`${BASE}/${enc(domain)}`, {
    method: "PUT",
    json: { in_ceiling: inCeiling },
  });
  return res.ok ? { ...res, data: res.data.domain } : res;
}

export function setPresetMembership(
  preset: EgressPreset,
  inCeiling: boolean,
): Promise<ApiResult<EgressCeiling>> {
  return apiRequest(`${BASE}/presets/${enc(preset)}`, {
    method: "PUT",
    json: { in_ceiling: inCeiling },
  });
}

/** Custom domains only; presets are taken out of the ceiling instead. */
export function deleteCeilingDomain(domain: string): Promise<ApiResult<void>> {
  return apiRequest(`${BASE}/${enc(domain)}`, { method: "DELETE" });
}

/** Marks a ceiling pattern internal (same cluster) or not (`PUT /:domain {internal}`). */
export async function setCeilingInternal(
  domain: string,
  internal: boolean,
): Promise<ApiResult<CeilingDomain>> {
  const res = await apiRequest<{ domain: CeilingDomain }>(`${BASE}/${enc(domain)}`, {
    method: "PUT",
    json: { internal },
  });
  return res.ok ? { ...res, data: res.data.domain } : res;
}

/** A site-scope access request: a host outside the ceiling or on an internal address. */
export interface SiteEgressRequest {
  readonly id: string;
  readonly domain: string;
  readonly pattern: string;
  readonly status: "pending" | "approved" | "denied";
  readonly scope: "team" | "site";
  readonly internal: boolean;
  readonly threadId: string | null;
  readonly requestedBy: { readonly id: string; readonly name: string };
  readonly createdAt: string;
  readonly team: { readonly id: string; readonly name: string };
}

export async function listSiteEgressRequests(): Promise<ApiResult<readonly SiteEgressRequest[]>> {
  const res = await apiRequest<{ requests: SiteEgressRequest[] }>(`${BASE}/requests`);
  return res.ok ? { ...res, data: res.data.requests } : res;
}

export interface SiteEgressDecision {
  readonly decision: "approve" | "deny";
  readonly pattern?: string;
  readonly internal?: boolean;
}

export function decideSiteEgressRequest(
  request: Pick<SiteEgressRequest, "id" | "team">,
  input: SiteEgressDecision,
): Promise<
  ApiResult<{ readonly settled: number; readonly enabled: boolean; readonly pattern: string }>
> {
  return apiRequest(`${BASE}/requests/${enc(request.team.id)}/${enc(request.id)}/decision`, {
    method: "POST",
    json: input,
  });
}

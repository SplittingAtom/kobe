/** Install console: egress ceiling (`/v1/install/egress-ceiling`, install.egress.manage; KOBE-38). */
import { apiRequest, type ApiResult } from "../../../api/client";

const enc = encodeURIComponent;
const BASE = "/v1/install/egress-ceiling";

export type EgressPreset = "package_registries" | "git_hosts" | "web_search";

export interface CeilingDomain {
  readonly domain: string;
  readonly preset: EgressPreset | null;
  readonly inCeiling: boolean;
  readonly note: string | null;
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
): Promise<ApiResult<CeilingDomain>> {
  const res = await apiRequest<{ domain: CeilingDomain }>(BASE, {
    method: "POST",
    json: { domain, note },
  });
  return res.ok ? { ...res, data: res.data.domain } : res;
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

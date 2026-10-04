/**
 * Team console: egress enablement (`/v1/team/egress`, team.egress.manage; KOBE-38), access
 * requests and injected headers (KOBE-39). Header values are write-only: sent, never read back.
 */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { EgressPreset } from "../install/egress";

const enc = encodeURIComponent;
const BASE = "/v1/team/egress";

export interface TeamEgressDomain {
  readonly domain: string;
  readonly preset: EgressPreset | null;
  /** In the install ceiling now; enablement only takes effect while it is. */
  readonly inCeiling: boolean;
  /** Shared hosting or a CDN: domain fronting may reach other sites behind it. */
  readonly sharedHosting: boolean;
  readonly enabled: boolean;
  readonly enabledBy: string | null;
  readonly enabledAt: string | null;
  /** Injected header names (KOBE-39); values are never returned. */
  readonly headerNames: readonly string[];
  readonly headersUpdatedAt: string | null;
}

export interface TeamEgressRequest {
  readonly id: string;
  readonly domain: string;
  readonly pattern: string;
  readonly status: "pending" | "approved" | "denied";
  readonly threadId: string | null;
  readonly requestedBy: { readonly id: string; readonly name: string };
  readonly decidedBy: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export interface InjectedHeader {
  readonly name: string;
  readonly value: string;
}

export async function listTeamEgress(
  teamId: string,
): Promise<ApiResult<readonly TeamEgressDomain[]>> {
  const res = await apiRequest<{ domains: TeamEgressDomain[] }>(BASE, { teamId });
  return res.ok ? { ...res, data: res.data.domains } : res;
}

export function enableTeamDomain(teamId: string, domain: string): Promise<ApiResult<unknown>> {
  return apiRequest(`${BASE}/domains/${enc(domain)}`, { method: "PUT", json: {}, teamId });
}

export function disableTeamDomain(teamId: string, domain: string): Promise<ApiResult<void>> {
  return apiRequest(`${BASE}/domains/${enc(domain)}`, { method: "DELETE", teamId });
}

export async function listEgressRequests(
  teamId: string,
): Promise<ApiResult<readonly TeamEgressRequest[]>> {
  const res = await apiRequest<{ requests: TeamEgressRequest[] }>(`${BASE}/requests`, { teamId });
  return res.ok ? { ...res, data: res.data.requests } : res;
}

export function decideEgressRequest(
  teamId: string,
  id: string,
  decision: "approve" | "deny",
): Promise<ApiResult<{ readonly settled: number; readonly enabled: boolean }>> {
  return apiRequest(`${BASE}/requests/${enc(id)}`, { method: "POST", json: { decision }, teamId });
}

/** Replaces the domain's injected headers (names and values; values are write-only). */
export function setDomainHeaders(
  teamId: string,
  domain: string,
  headers: readonly InjectedHeader[],
): Promise<ApiResult<unknown>> {
  return apiRequest(`${BASE}/domains/${enc(domain)}/headers`, {
    method: "PUT",
    json: { headers: headers.map((h) => ({ name: h.name, value: h.value })) },
    teamId,
  });
}

export function clearDomainHeaders(teamId: string, domain: string): Promise<ApiResult<void>> {
  return apiRequest(`${BASE}/domains/${enc(domain)}/headers`, { method: "DELETE", teamId });
}

/** Team console: egress enablement (`/v1/team/egress`, team.egress.manage; KOBE-38). */
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

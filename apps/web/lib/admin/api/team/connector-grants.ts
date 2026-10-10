/**
 * A member's own connector API keys (`/v1/connector-grants`, KOBE-108). The key goes in on PUT and
 * never comes back: responses carry a masked hint and timestamps only.
 */
import { apiRequest, type ApiResult } from "../../../api/client";

const BASE = "/v1/connector-grants";

export interface ConnectorGrant {
  readonly connectorId: string;
  /** Masked: at most the last four characters of a long key. */
  readonly hint: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Same bounds as the server: 8 to 2048 visible ASCII characters. */
export const KEY_PATTERN = /^[\x21-\x7e]{8,2048}$/;
export const KEY_HINT =
  "Paste the key exactly as the service gave it (8 to 2048 characters, no spaces).";

export async function listGrants(teamId: string): Promise<ApiResult<readonly ConnectorGrant[]>> {
  const res = await apiRequest<{ grants: readonly ConnectorGrant[] }>(BASE, { teamId });
  return res.ok ? { ...res, data: res.data.grants } : res;
}

/** Adds or replaces the caller's key; the result carries the hint only. */
export async function saveGrant(
  teamId: string,
  connectorId: string,
  apiKey: string,
): Promise<ApiResult<ConnectorGrant>> {
  const res = await apiRequest<{ grant: ConnectorGrant }>(
    `${BASE}/${encodeURIComponent(connectorId)}`,
    { method: "PUT", json: { api_key: apiKey }, teamId },
  );
  return res.ok ? { ...res, data: res.data.grant } : res;
}

export const removeGrant = (teamId: string, connectorId: string): Promise<ApiResult<unknown>> =>
  apiRequest(`${BASE}/${encodeURIComponent(connectorId)}`, { method: "DELETE", teamId });

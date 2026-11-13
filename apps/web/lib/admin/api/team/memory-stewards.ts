/**
 * Team console: Workspace memory stewards (`/v1/team/memory/stewards`, KOBE-380; Team admins).
 * Responses arrive camelized. Every call names the team (`X-Kobe-Team`).
 */
import { apiRequest, type ApiResult } from "../../../api/client";

const enc = encodeURIComponent;

export interface MemorySteward {
  readonly userId: string;
  readonly name: string;
  readonly grantedBy: string;
  readonly grantedAt: string;
}

export async function listMemoryStewards(
  teamId: string,
): Promise<ApiResult<readonly MemorySteward[]>> {
  const res = await apiRequest<{ level: "team"; stewards: MemorySteward[] }>(
    "/v1/team/memory/stewards",
    { teamId },
  );
  return res.ok ? { ...res, data: res.data.stewards } : res;
}

export function grantMemorySteward(
  teamId: string,
  userId: string,
): Promise<ApiResult<MemorySteward>> {
  return apiRequest(`/v1/team/memory/stewards/${enc(userId)}`, {
    method: "PUT",
    json: {},
    teamId,
  });
}

export function revokeMemorySteward(teamId: string, userId: string): Promise<ApiResult<void>> {
  return apiRequest(`/v1/team/memory/stewards/${enc(userId)}`, { method: "DELETE", teamId });
}

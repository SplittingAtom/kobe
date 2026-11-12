/** Team console: members and roles (`/v1/team/members`). Every call names the team (`X-Kobe-Team`). */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { TeamRole } from "../../../teams";
import type { RosterMember } from "../site/teams";

const enc = encodeURIComponent;

export type TeamMember = RosterMember;

export async function listTeamMembers(teamId: string): Promise<ApiResult<readonly TeamMember[]>> {
  const res = await apiRequest<{ members: TeamMember[] }>("/v1/team/members", { teamId });
  return res.ok ? { ...res, data: res.data.members } : res;
}

export function setMemberRole(
  teamId: string,
  userId: string,
  role: TeamRole,
): Promise<ApiResult<unknown>> {
  return apiRequest(`/v1/team/members/${enc(userId)}`, { method: "PATCH", json: { role }, teamId });
}

export function removeMember(teamId: string, userId: string): Promise<ApiResult<void>> {
  return apiRequest(`/v1/team/members/${enc(userId)}`, { method: "DELETE", teamId });
}

/** Take over (KOBE-627, SSO10): a provider-managed membership becomes the team's own. */
export function takeOverMember(teamId: string, userId: string): Promise<ApiResult<unknown>> {
  return apiRequest(`/v1/team/members/${enc(userId)}/take-over`, { method: "POST", teamId });
}

/** An access mapping that targets this team (read-only for team admins, spec sso §7). */
export interface TeamSsoMapping {
  readonly id: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly claimValue: string;
  readonly role: TeamRole;
}

export async function listTeamSsoMappings(
  teamId: string,
): Promise<ApiResult<readonly TeamSsoMapping[]>> {
  const res = await apiRequest<{ mappings: TeamSsoMapping[] }>("/v1/team/sso-mappings", {
    teamId,
  });
  return res.ok ? { ...res, data: res.data.mappings } : res;
}

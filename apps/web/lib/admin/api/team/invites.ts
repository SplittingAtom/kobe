/** Team console: invitations (`/v1/team/invites`, KOBE-13). Every call names the team. */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { TeamRole } from "../../../teams";

const enc = encodeURIComponent;

export interface TeamInvite {
  readonly id: string;
  readonly email: string;
  readonly role: TeamRole;
  readonly invitedBy: { readonly id: string; readonly name: string };
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: "pending" | "expired";
}

export async function listTeamInvites(teamId: string): Promise<ApiResult<readonly TeamInvite[]>> {
  const res = await apiRequest<{ invitations: TeamInvite[] }>("/v1/team/invites", { teamId });
  return res.ok ? { ...res, data: res.data.invitations } : res;
}

export function inviteToTeam(
  teamId: string,
  email: string,
  role: TeamRole,
): Promise<ApiResult<unknown>> {
  return apiRequest("/v1/team/invites", { method: "POST", json: { email, role }, teamId });
}

export function revokeTeamInvite(teamId: string, id: string): Promise<ApiResult<void>> {
  return apiRequest(`/v1/team/invites/${enc(id)}`, { method: "DELETE", teamId });
}

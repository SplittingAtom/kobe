/**
 * Team console resources (`/v1/team/*`, `/v1/agents`). Every call names the team it acts on
 * (`X-Kobe-Team`): if another tab switched teams, the server answers 409 `team_mismatch`.
 */
import { apiRequest, type ApiResult } from "../../api/client";
import type { TeamRole } from "../../teams";
import type { AgentSaved, AgentSummary, RosterMember } from "./install";

const enc = encodeURIComponent;

export type TeamMember = RosterMember;

export interface TeamInvite {
  readonly id: string;
  readonly email: string;
  readonly role: TeamRole;
  readonly invitedBy: { readonly id: string; readonly name: string };
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: "pending" | "expired";
}

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

export async function listTeamAgents(teamId: string): Promise<ApiResult<readonly AgentSummary[]>> {
  const res = await apiRequest<{ agents: AgentSummary[] }>("/v1/agents?scope=team", { teamId });
  return res.ok ? { ...res, data: res.data.agents } : res;
}

export function setTeamAgentStatus(
  teamId: string,
  id: string,
  status: AgentSummary["status"],
): Promise<ApiResult<AgentSaved>> {
  return apiRequest(`/v1/agents/${enc(id)}/status`, { method: "PUT", json: { status }, teamId });
}

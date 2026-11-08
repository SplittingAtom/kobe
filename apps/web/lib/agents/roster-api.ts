/**
 * The agent rosters (KOBE-566 server, spec agents-roster AR16): the Agents page's tab reads and
 * the assign, propose, withdraw and roster-admin writes. Every call names the active team. The
 * rows say what the viewer may do (`row.actions`); the server checks every write again.
 */
import type {
  AgentRosterEntryResponse,
  AgentRosterPage,
  AgentRosterTab,
  AgentRosterTarget,
  AgentRosterUpdateResponse,
  AgentVersionRuleInput,
  UpdateAgentRosterEntryRequest,
} from "@kobe/protocol";
import { apiRequest, type ApiResult } from "../api/client";
import type { AgentSaved } from "../admin/api/agents";

const enc = encodeURIComponent;

/** One page of a tab, ordered by (name, id); `cursor` is the previous page's `nextCursor`. */
export function listRoster(
  teamId: string,
  tab: AgentRosterTab,
  cursor?: string | null,
): Promise<ApiResult<AgentRosterPage>> {
  const query = new URLSearchParams({ tab });
  if (cursor) query.set("cursor", cursor);
  return apiRequest<AgentRosterPage>(`/v1/agents/roster?${query.toString()}`, { teamId });
}

/** Assigns the agent (201, `active`) or proposes it (202, `proposed`): `res.status` tells which. */
export function assignAgent(
  teamId: string,
  agentId: string,
  target: AgentRosterTarget,
  versionRule?: AgentVersionRuleInput,
): Promise<ApiResult<AgentRosterEntryResponse>> {
  return apiRequest(`/v1/agents/${enc(agentId)}/assignments`, {
    method: "POST",
    json: versionRule === undefined ? { target } : { target, versionRule },
    teamId,
  });
}

/**
 * The owner withdraws the agent (or its proposal) from a roster. `fromTeamId` names a team roster
 * other than the active team's (one the owner has left).
 */
export function withdrawAgent(
  teamId: string,
  agentId: string,
  target: AgentRosterTarget,
  fromTeamId?: string,
): Promise<ApiResult<AgentRosterEntryResponse>> {
  const query = fromTeamId ? `?teamId=${enc(fromTeamId)}` : "";
  return apiRequest(`/v1/agents/${enc(agentId)}/assignments/${target}${query}`, {
    method: "DELETE",
    teamId,
  });
}

/**
 * A roster admin's write: approve, decline, pin, update, remove, suspend or resume, on the team
 * roster (team admins) or the site roster (site admins).
 */
export function updateRosterEntry(
  teamId: string,
  roster: AgentRosterTarget,
  agentId: string,
  body: UpdateAgentRosterEntryRequest,
): Promise<ApiResult<AgentRosterUpdateResponse>> {
  return apiRequest(`/v1/${roster}/agent-roster/${enc(agentId)}`, {
    method: "PUT",
    json: body,
    teamId,
  });
}

/** Today's fork (KOBE-87) aimed at Personal: the copy is the forker's own personal agent (AR8). */
export function forkToPersonal(teamId: string, agentId: string): Promise<ApiResult<AgentSaved>> {
  return apiRequest(`/v1/agents/${enc(agentId)}/fork`, {
    method: "POST",
    json: { scope: "personal" },
    teamId,
  });
}

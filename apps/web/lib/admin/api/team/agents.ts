/** Team console: team agents (`/v1/agents?scope=team`, KOBE-45/46). Every call names the team. */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { AgentSaved, AgentSummary, GalleryScore } from "../agents";

const enc = encodeURIComponent;

export async function listTeamAgents(teamId: string): Promise<ApiResult<readonly AgentSummary[]>> {
  const res = await apiRequest<{ agents: AgentSummary[] }>(
    "/v1/agents?scope=team&include_archived=true",
    { teamId },
  );
  return res.ok ? { ...res, data: res.data.agents } : res;
}

/** The caller's own personal agents (the server lists nobody else's, KOBE-45/97). */
export async function listPersonalAgents(
  teamId: string,
): Promise<ApiResult<readonly AgentSummary[]>> {
  const res = await apiRequest<{ agents: AgentSummary[] }>(
    "/v1/agents?scope=personal&include_archived=true",
    { teamId },
  );
  return res.ok ? { ...res, data: res.data.agents } : res;
}

export function setTeamAgentStatus(
  teamId: string,
  id: string,
  status: AgentSummary["status"],
): Promise<ApiResult<AgentSaved>> {
  return apiRequest(`/v1/agents/${enc(id)}/status`, { method: "PUT", json: { status }, teamId });
}

/** Published Orbit scores of the gallery's current versions, for every member (KOBE-94). */
export async function listGalleryScores(
  teamId: string,
): Promise<ApiResult<readonly GalleryScore[]>> {
  const res = await apiRequest<{ scores: GalleryScore[] }>("/v1/agents/gallery-scores", { teamId });
  return res.ok ? { ...res, data: res.data.scores } : res;
}

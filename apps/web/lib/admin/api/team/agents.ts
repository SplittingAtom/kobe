/** Team console: team agents (`/v1/agents?scope=team`, KOBE-45/46). Every call names the team. */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { AgentSaved, AgentSummary } from "../agents";

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

/** The read-only gallery, available to every team (KOBE-87). */
export async function listGalleryAgents(
  teamId: string,
): Promise<ApiResult<readonly AgentSummary[]>> {
  const res = await apiRequest<{ agents: AgentSummary[] }>("/v1/agents?scope=gallery", { teamId });
  return res.ok ? { ...res, data: res.data.agents } : res;
}

/** Copies a gallery agent into this team as an editable draft (needs team.agents.build). */
export function forkGalleryAgent(teamId: string, id: string): Promise<ApiResult<AgentSaved>> {
  return apiRequest(`/v1/agents/${enc(id)}/fork`, {
    method: "POST",
    json: { scope: "team" },
    teamId,
  });
}

export function setTeamAgentStatus(
  teamId: string,
  id: string,
  status: AgentSummary["status"],
): Promise<ApiResult<AgentSaved>> {
  return apiRequest(`/v1/agents/${enc(id)}/status`, { method: "PUT", json: { status }, teamId });
}

/** One row of the team admin inventory (`GET /v1/agents/inventory`, KOBE-86). */
export interface InventoryAgent {
  readonly id: string;
  readonly scope: "team" | "personal" | "gallery";
  readonly slug: string;
  readonly name: string;
  readonly ownerName: string | null;
  readonly status: "active" | "suspended";
  readonly archivedAt: string | null;
  readonly currentVersion: number | null;
  readonly runCount: number;
  readonly lastRunAt: string | null;
  /** Input plus output tokens; money is not shown (only exact cost may be). */
  readonly tokens: number;
  /** Not built yet (KOBE-64): null. */
  readonly schedules: null;
  /** Not built yet (KOBE-52): null. */
  readonly orbitScore: null;
  /** The caller may read this agent's definition, which exporting a version needs (KOBE-91). */
  readonly canExport?: boolean;
}

export interface InventoryPage {
  readonly agents: readonly InventoryAgent[];
  readonly nextCursor: string | null;
}

export function listAgentInventory(
  teamId: string,
  cursor: string | null = null,
): Promise<ApiResult<InventoryPage>> {
  const query = cursor === null ? "" : `?cursor=${enc(cursor)}`;
  return apiRequest(`/v1/agents/inventory${query}`, { teamId });
}

/** Suspends or reactivates a team agent or a used personal/gallery agent, for this team. */
export function setInventoryAgentStatus(
  teamId: string,
  id: string,
  status: InventoryAgent["status"],
): Promise<ApiResult<{ id: string; status: InventoryAgent["status"] }>> {
  return apiRequest(`/v1/agents/inventory/${enc(id)}/status`, {
    method: "PUT",
    json: { status },
    teamId,
  });
}

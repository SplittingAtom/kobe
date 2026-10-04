/** Team console: the agent builder's calls (`/v1/agents`, drafts and versions, KOBE-45/46). */
import { apiRequest, type ApiResult } from "../../../api/client";
import { revisionTag, type AgentSaved, type AgentSummary } from "../agents";

const enc = encodeURIComponent;

/** A draft with its definition. `frontmatter` keeps the file's own (snake_case) keys. */
export interface AgentDetail extends AgentSummary {
  readonly frontmatter: Record<string, unknown>;
  readonly prompt: string;
}

export interface AgentDetailSaved {
  readonly agent: AgentDetail;
  readonly warnings?: readonly unknown[];
}

export interface AgentVersionSummary {
  readonly version: number;
  readonly publishedBy: string | null;
  readonly publishedAt: string;
  readonly draftRevision: number;
  readonly republishedFrom: number | null;
}

export interface VersionPage {
  readonly currentVersion: number | null;
  readonly versions: readonly AgentVersionSummary[];
  readonly nextBefore: number | null;
}

/** A publish or rollback answer: the agent as it now stands and the version just created. */
export interface PublishedAgent extends AgentDetailSaved {
  readonly version: AgentVersionSummary;
}

export interface DefinitionBody {
  readonly frontmatter: Record<string, unknown>;
  readonly prompt: string;
}

export type { AgentSaved };

export const getTeamAgent = (teamId: string, id: string): Promise<ApiResult<AgentDetailSaved>> =>
  apiRequest(`/v1/agents/${enc(id)}`, { teamId });

export const createTeamAgent = (
  teamId: string,
  body: DefinitionBody & { readonly slug?: string | undefined },
): Promise<ApiResult<AgentDetailSaved>> =>
  apiRequest("/v1/agents", { method: "POST", json: { scope: "team", ...body }, teamId });

export const saveTeamAgent = (
  teamId: string,
  agent: Pick<AgentSummary, "id" | "revision">,
  body: DefinitionBody,
): Promise<ApiResult<AgentDetailSaved>> =>
  apiRequest(`/v1/agents/${enc(agent.id)}`, {
    method: "PUT",
    json: body,
    teamId,
    ifMatch: revisionTag(agent),
  });

export const publishTeamAgent = (
  teamId: string,
  agent: Pick<AgentSummary, "id" | "revision">,
): Promise<ApiResult<PublishedAgent>> =>
  apiRequest(`/v1/agents/${enc(agent.id)}/publish`, {
    method: "POST",
    teamId,
    ifMatch: revisionTag(agent),
  });

export const listTeamAgentVersions = (
  teamId: string,
  id: string,
  before?: number,
): Promise<ApiResult<VersionPage>> =>
  apiRequest(`/v1/agents/${enc(id)}/versions${before === undefined ? "" : `?before=${before}`}`, {
    teamId,
  });

export const rollbackTeamAgent = (
  teamId: string,
  id: string,
  version: number,
): Promise<ApiResult<PublishedAgent>> =>
  apiRequest(`/v1/agents/${enc(id)}/rollback`, { method: "POST", json: { version }, teamId });

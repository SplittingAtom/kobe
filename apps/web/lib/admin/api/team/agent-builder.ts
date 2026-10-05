/** Team console: the agent builder's calls (`/v1/agents`, drafts and versions, KOBE-45/46). */
import { apiRequest, apiTextFile, type ApiResult, type TextFile } from "../../../api/client";
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

/** What an eval of a version earned in the team's pre-publish gate (KOBE-93). */
export interface VersionScore {
  readonly attackSuccessRate: number;
  readonly threshold: number;
  readonly evalId: string;
}

export interface AgentVersionSummary {
  readonly version: number;
  /** Absent on responses from routes without the gate (rollback, gallery). */
  readonly score?: VersionScore | null;
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

export type EvalStatus = "pending" | "running" | "passed" | "blocked" | "errored";

/** One pre-publish Orbit eval of a draft (`/v1/agents/{id}/evals`, KOBE-93). */
export interface AgentEval {
  readonly id: string;
  readonly status: EvalStatus;
  readonly draftRevision: number;
  /** The team's ceiling when the eval was requested (0 to 1). */
  readonly threshold: number;
  readonly attackSuccessRate: number | null;
  readonly attempts: number | null;
  readonly attackSuccesses: number | null;
  readonly error: string | null;
  /** The version published when it passed. */
  readonly version: number | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** Publish with the gate on answers 202: an eval started, the version comes if it passes. */
export interface EvalStarted {
  readonly eval: AgentEval;
  readonly message: string;
}

export interface EvalList {
  readonly evals: readonly AgentEval[];
  /** The unfinished eval, if any. */
  readonly active: AgentEval | null;
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
  scope: "team" | "personal" = "team",
): Promise<ApiResult<AgentDetailSaved>> =>
  apiRequest("/v1/agents", { method: "POST", json: { scope, ...body }, teamId });

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
): Promise<ApiResult<PublishedAgent | EvalStarted>> =>
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

/** A published version as Orbit YAML (`GET /v1/agents/{id}/versions/{n}/orbit`, KOBE-91). */
export const exportTeamAgentToOrbit = (
  teamId: string,
  id: string,
  version: number,
): Promise<ApiResult<TextFile>> =>
  apiTextFile(`/v1/agents/${enc(id)}/versions/${version}/orbit`, { teamId });

export const listTeamAgentEvals = (teamId: string, id: string): Promise<ApiResult<EvalList>> =>
  apiRequest(`/v1/agents/${enc(id)}/evals`, { teamId });

/** True for the 202 answer of a gated Publish. */
export const isEvalStarted = (answer: PublishedAgent | EvalStarted): answer is EvalStarted =>
  "eval" in answer;

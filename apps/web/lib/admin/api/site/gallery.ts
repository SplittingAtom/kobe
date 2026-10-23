/** Site console: gallery agents (`/v1/site`, site.gallery.manage). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";
import { revisionTag, type AgentSummary, type GalleryScore } from "../agents";
import type { AgentDetail, DefinitionBody } from "../team/agent-builder";
import type { TeamConnector } from "../team/connectors";
import type { TeamModels } from "../team/models";
import type { MyTeams } from "../../../teams";

const enc = encodeURIComponent;

export const GALLERY_PATH = "/v1/site/gallery/agents";

/**
 * Where a gallery agent stands against the repository definition (KOBE-494): Customized after a
 * site admin's first edit; `updateAvailable` once the repository moved on since.
 */
export interface GalleryState {
  readonly key: string | null;
  readonly generation: number | null;
  readonly customized: boolean;
  readonly customizedAt: string | null;
  readonly customizedBy: string | null;
  readonly customizedFromGeneration: number | null;
  readonly updateAvailable: boolean;
}

export interface GalleryAgentSummary extends AgentSummary {
  /** Absent from servers before KOBE-494. */
  readonly gallery?: GalleryState | null;
}

export interface GalleryAgentDetail extends AgentDetail {
  readonly gallery?: GalleryState | null;
}

export interface GalleryAgentSaved {
  readonly agent: GalleryAgentDetail;
}

/** One side of Compare: a definition as its agent file. */
export interface ComparedDefinition {
  readonly frontmatter: Record<string, unknown>;
  readonly prompt: string;
  readonly file: string;
}

export interface GalleryComparison {
  readonly gallery: GalleryState;
  readonly repository: (ComparedDefinition & { readonly generation: number }) | null;
  readonly current: (ComparedDefinition & { readonly version: number }) | null;
}

/** A published gallery version (newest first); `publishedBy` null: the repository seed. */
export interface GalleryVersion {
  readonly version: number;
  readonly publishedBy: string | null;
  readonly publishedAt: string;
}

/** The site's models and active connectors the gallery agent editor offers. */
export interface GalleryBuilderOptions {
  readonly models: TeamModels;
  readonly connectors: readonly TeamConnector[];
}

/** Gallery agents come from the repo's definitions (KOBE-87); site admins may edit them (KOBE-494). */
export async function listGalleryAgents(): Promise<ApiResult<readonly GalleryAgentSummary[]>> {
  const res = await apiRequest<{ agents: GalleryAgentSummary[] }>(GALLERY_PATH);
  return res.ok ? { ...res, data: res.data.agents } : res;
}

export const getGalleryAgent = (id: string): Promise<ApiResult<GalleryAgentSaved>> =>
  apiRequest(`${GALLERY_PATH}/${enc(id)}`);

/** Saves the draft (If-Match: the revision shown); the first save marks the agent Customized. */
export const saveGalleryAgent = (
  agent: Pick<AgentSummary, "id" | "revision">,
  body: DefinitionBody,
): Promise<ApiResult<GalleryAgentSaved>> =>
  apiRequest(`${GALLERY_PATH}/${enc(agent.id)}`, {
    method: "PUT",
    json: body,
    ifMatch: revisionTag(agent),
  });

/** Publishes the saved draft as a new immutable version (D19). */
export const publishGalleryAgent = (
  agent: Pick<AgentSummary, "id" | "revision">,
): Promise<ApiResult<{ readonly agent: GalleryAgentDetail; readonly version: GalleryVersion }>> =>
  apiRequest(`${GALLERY_PATH}/${enc(agent.id)}/publish`, {
    method: "POST",
    ifMatch: revisionTag(agent),
  });

export async function listGalleryVersions(
  id: string,
): Promise<ApiResult<readonly GalleryVersion[]>> {
  const res = await apiRequest<{ versions: GalleryVersion[] }>(
    `${GALLERY_PATH}/${enc(id)}/versions`,
  );
  return res.ok ? { ...res, data: res.data.versions } : res;
}

export const compareGalleryAgent = (id: string): Promise<ApiResult<GalleryComparison>> =>
  apiRequest(`${GALLERY_PATH}/${enc(id)}/compare`);

/** Re-attaches the agent to the repository definition, published as a new version. */
export const resetGalleryAgent = (id: string): Promise<ApiResult<GalleryAgentSaved>> =>
  apiRequest(`${GALLERY_PATH}/${enc(id)}/reset`, { method: "POST" });

export const getGalleryBuilderOptions = (): Promise<ApiResult<GalleryBuilderOptions>> =>
  apiRequest(`${GALLERY_PATH}/builder-options`);

export function galleryExportHref(id: string): string {
  return `${GALLERY_PATH}/${enc(id)}/export`;
}

/** Published Orbit scores of the current versions (KOBE-94). */
export async function listGalleryScores(): Promise<ApiResult<readonly GalleryScore[]>> {
  const res = await apiRequest<{ scores: GalleryScore[] }>(`${GALLERY_PATH}/scores`);
  return res.ok ? { ...res, data: res.data.scores } : res;
}

/** Starts the eval of an agent's current version in `teamId` (a team the caller belongs to); 202. */
export function runGalleryEval(
  id: string,
  teamId: string,
): Promise<ApiResult<{ message: string }>> {
  return apiRequest(`${GALLERY_PATH}/${enc(id)}/eval`, { method: "POST", json: { teamId } });
}

/** The teams the caller may run an eval in. */
export function listMyTeamsForEval(): Promise<ApiResult<MyTeams>> {
  return apiRequest("/v1/me/teams");
}

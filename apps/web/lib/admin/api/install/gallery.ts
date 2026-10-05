/** Install console: gallery agents (`/v1/install`, install.gallery.manage). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { AgentSummary, GalleryScore } from "../agents";
import type { MyTeams } from "../../../teams";

const enc = encodeURIComponent;

export const GALLERY_PATH = "/v1/install/gallery/agents";

/** Read-only: gallery agents come from the repo's definitions (KOBE-87), the API has no writes. */
export async function listGalleryAgents(): Promise<ApiResult<readonly AgentSummary[]>> {
  const res = await apiRequest<{ agents: AgentSummary[] }>(GALLERY_PATH);
  return res.ok ? { ...res, data: res.data.agents } : res;
}

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

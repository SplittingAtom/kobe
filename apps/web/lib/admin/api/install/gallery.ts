/** Install console: gallery agents (`/v1/install`, install.gallery.manage). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { AgentSummary } from "../agents";

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

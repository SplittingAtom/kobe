/** Install console: gallery agents (`/v1/install`, install.gallery.manage). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { AgentSaved, AgentSummary } from "../agents";

const enc = encodeURIComponent;

export const GALLERY_PATH = "/v1/install/gallery/agents";

export async function listGalleryAgents(): Promise<ApiResult<readonly AgentSummary[]>> {
  const res = await apiRequest<{ agents: AgentSummary[] }>(GALLERY_PATH);
  return res.ok ? { ...res, data: res.data.agents } : res;
}

export function setGalleryAgentStatus(
  id: string,
  status: AgentSummary["status"],
): Promise<ApiResult<AgentSaved>> {
  return apiRequest(`${GALLERY_PATH}/${enc(id)}/status`, { method: "PUT", json: { status } });
}

export function deleteGalleryAgent(id: string): Promise<ApiResult<void>> {
  return apiRequest(`${GALLERY_PATH}/${enc(id)}`, { method: "DELETE" });
}

/** Imports an agent markdown file (§6.3) into the gallery. */
export function importGalleryAgent(file: string): Promise<ApiResult<AgentSaved>> {
  return apiRequest(GALLERY_PATH, {
    method: "POST",
    raw: { body: file, contentType: "text/markdown; charset=utf-8" },
  });
}

export function galleryExportHref(id: string): string {
  return `${GALLERY_PATH}/${enc(id)}/export`;
}

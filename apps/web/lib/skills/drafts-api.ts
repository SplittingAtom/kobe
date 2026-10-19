/**
 * Workbench drafts (`/v1/skills/drafts`, KOBE-320/321). Every call names the active team; every
 * change names the revision it was made against (`If-Match`), and a stale one comes back as 409
 * `stale_revision` whose message says who changed the draft.
 */
import { apiRequest, apiTextFile, type ApiResult } from "../api/client";
import type { SkillSaved } from "../admin/api/team/skills";

const enc = encodeURIComponent;
const BASE = "/v1/skills/drafts";

export type DraftStart = "blank" | "template" | "fork" | "upload" | "thread" | "git";

export interface DraftSummary {
  readonly id: string;
  readonly name: string;
  readonly shared: boolean;
  /** The caller wrote it (the author). */
  readonly mine: boolean;
  readonly ownerUserId: string;
  readonly startedFrom: DraftStart;
  readonly parentRef: Readonly<Record<string, unknown>> | null;
  readonly fromConversation: boolean;
  readonly coEdited: boolean;
  readonly rev: number;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface DraftFileInfo {
  readonly path: string;
  readonly size: number;
  readonly kind: "text" | "binary";
  readonly updatedAt: string;
}

export interface DraftPage {
  readonly drafts: readonly DraftSummary[];
  readonly next: string | null;
}

export interface DraftWithFiles {
  readonly draft: DraftSummary;
  readonly files: readonly DraftFileInfo[];
}

export interface ScanFinding {
  readonly category: string;
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly excerpt: string;
  readonly severity: "caution" | "block";
}

export interface ScanPreview {
  readonly rev: number;
  readonly verdict: "pass" | "caution" | "block";
  readonly findings: readonly ScanFinding[];
  readonly scripts: readonly string[];
  readonly skipped: readonly string[];
}

export type BumpKind = "major" | "minor" | "patch";

export interface BumpSuggestion {
  readonly rev: number;
  readonly latest: { readonly skillId: string; readonly semver: string } | null;
  readonly kind: BumpKind | null;
  readonly suggested: string | null;
  readonly reasons: readonly string[];
}

export type Destination = "team" | "personal";

export interface SaveVersionRequest {
  readonly destination: Destination;
  readonly semver: string;
  readonly changelog: string;
  readonly confirmPersonal?: boolean;
}

/** A path as URL segments, each encoded on its own (the server decodes them one by one). */
export const filePath = (path: string): string => path.split("/").map(enc).join("/");
const etag = (rev: number) => `"${rev}"`;

export function listDrafts(teamId: string, cursor?: string): Promise<ApiResult<DraftPage>> {
  return apiRequest(cursor ? `${BASE}?cursor=${enc(cursor)}` : BASE, { teamId });
}

const draftOf = (res: ApiResult<{ draft: DraftSummary }>): ApiResult<DraftSummary> =>
  res.ok ? { ...res, data: res.data.draft } : res;

/** A blank draft, or one from a template (KOBE-322). */
export async function createDraft(
  teamId: string,
  name: string,
  template?: string,
): Promise<ApiResult<DraftSummary>> {
  return draftOf(
    await apiRequest(BASE, {
      method: "POST",
      json: template ? { name, template } : { name },
      teamId,
    }),
  );
}

export interface DraftTemplate {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
}

export async function listTemplates(teamId: string): Promise<ApiResult<readonly DraftTemplate[]>> {
  const res = await apiRequest<{ templates: DraftTemplate[] }>(`${BASE}/templates`, { teamId });
  return res.ok ? { ...res, data: res.data.templates } : res;
}

/** A draft from an uploaded zip or SKILL.md, through the upload's validation (KOBE-322). */
export async function uploadDraft(
  teamId: string,
  bytes: Uint8Array,
  kind: "zip" | "skill_md",
): Promise<ApiResult<DraftSummary>> {
  return draftOf(
    await apiRequest(`${BASE}/upload?kind=${kind}`, {
      method: "POST",
      raw: { body: bytes, contentType: kind === "zip" ? "application/zip" : "text/markdown" },
      teamId,
    }),
  );
}

export type ForkSource =
  | { readonly kind: "team" | "personal"; readonly skillId: string; readonly version?: number }
  | { readonly kind: "catalog"; readonly skillId: string; readonly semver?: string };

/** A copy of a version as a new draft; under the skill's own name, it is how a skill is edited. */
export async function forkToDraft(
  teamId: string,
  source: ForkSource,
  name?: string,
): Promise<ApiResult<DraftSummary>> {
  return draftOf(
    await apiRequest(`${BASE}/fork`, {
      method: "POST",
      json: name ? { source, name } : { source },
      teamId,
    }),
  );
}

/** Save to Workbench: `/workspace/skills/<folder>/` from the conversation `threadId`. */
export async function saveWorkspaceSkill(
  teamId: string,
  threadId: string,
  folder: string,
): Promise<ApiResult<DraftSummary>> {
  return draftOf(
    await apiRequest(`${BASE}/from-workspace`, {
      method: "POST",
      json: { threadId, folder },
      teamId,
    }),
  );
}

export function getDraft(teamId: string, id: string): Promise<ApiResult<DraftWithFiles>> {
  return apiRequest(`${BASE}/${enc(id)}`, { teamId });
}

export async function readDraftText(
  teamId: string,
  id: string,
  path: string,
): Promise<ApiResult<string>> {
  const res = await apiTextFile(`${BASE}/${enc(id)}/files/${filePath(path)}`, { teamId });
  return res.ok ? { ...res, data: res.data.text } : res;
}

export interface Changed {
  readonly rev: number;
  readonly draft: DraftSummary;
}

export function putDraftFile(
  teamId: string,
  id: string,
  path: string,
  rev: number,
  text: string,
): Promise<ApiResult<Changed>> {
  return apiRequest(`${BASE}/${enc(id)}/files/${filePath(path)}`, {
    method: "PUT",
    raw: { body: text, contentType: "text/plain; charset=utf-8" },
    ifMatch: etag(rev),
    teamId,
  });
}

export function deleteDraftFile(
  teamId: string,
  id: string,
  path: string,
  rev: number,
): Promise<ApiResult<Changed>> {
  return apiRequest(`${BASE}/${enc(id)}/files/${filePath(path)}`, {
    method: "DELETE",
    ifMatch: etag(rev),
    teamId,
  });
}

export async function shareDraft(
  teamId: string,
  id: string,
  rev: number,
  shared: boolean,
): Promise<ApiResult<DraftSummary>> {
  const res = await apiRequest<{ draft: DraftSummary }>(`${BASE}/${enc(id)}`, {
    method: "PATCH",
    json: { shared },
    ifMatch: etag(rev),
    teamId,
  });
  return res.ok ? { ...res, data: res.data.draft } : res;
}

export function deleteDraft(teamId: string, id: string): Promise<ApiResult<unknown>> {
  return apiRequest(`${BASE}/${enc(id)}`, { method: "DELETE", teamId });
}

export function scanDraft(
  teamId: string,
  id: string,
  signal?: AbortSignal,
): Promise<ApiResult<ScanPreview>> {
  return apiRequest(`${BASE}/${enc(id)}/scan`, { teamId, signal });
}

export function suggestBump(
  teamId: string,
  id: string,
  destination: Destination,
): Promise<ApiResult<BumpSuggestion>> {
  return apiRequest(`${BASE}/${enc(id)}/bump?destination=${destination}`, { teamId });
}

export function saveDraftVersion(
  teamId: string,
  id: string,
  rev: number,
  body: SaveVersionRequest,
): Promise<ApiResult<SkillSaved>> {
  return apiRequest(`${BASE}/${enc(id)}/versions`, {
    method: "POST",
    json: body,
    ifMatch: etag(rev),
    teamId,
  });
}

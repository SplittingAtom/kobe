/**
 * What the Workbench editor (`use-draft-editor.ts`) calls to read and change a draft: a team's
 * Workbench draft by default, or a Site draft of a catalog skill (KOBE-495), which keeps the same
 * revisions, autosave and scan preview behind other routes.
 */
import type { ApiResult } from "../api/client";
import {
  deleteDraftFile,
  getDraft,
  putDraftFile,
  readDraftText,
  scanDraft,
  shareDraft,
  type Changed,
  type DraftSummary,
  type DraftWithFiles,
  type ScanPreview,
} from "./drafts-api";

export interface DraftClient {
  get(id: string): Promise<ApiResult<DraftWithFiles>>;
  readText(id: string, path: string): Promise<ApiResult<string>>;
  put(id: string, path: string, rev: number, text: string): Promise<ApiResult<Changed>>;
  remove(id: string, path: string, rev: number): Promise<ApiResult<Changed>>;
  share(id: string, rev: number, shared: boolean): Promise<ApiResult<DraftSummary>>;
  scan(id: string, signal?: AbortSignal): Promise<ApiResult<ScanPreview>>;
}

/** The active team's Workbench drafts (`/v1/skills/drafts`). */
export function teamDraftClient(teamId: string): DraftClient {
  return {
    get: (id) => getDraft(teamId, id),
    readText: (id, path) => readDraftText(teamId, id, path),
    put: (id, path, rev, text) => putDraftFile(teamId, id, path, rev, text),
    remove: (id, path, rev) => deleteDraftFile(teamId, id, path, rev),
    share: (id, rev, shared) => shareDraft(teamId, id, rev, shared),
    scan: (id, signal) => scanDraft(teamId, id, signal),
  };
}

/**
 * The Workbench editor's client for a Site draft of a catalog skill (KOBE-495): the draft is
 * addressed by its skill's id, and its record is shown in the editor's own shape (a Site draft is
 * shared by the Site admins and never started from a conversation).
 */
import type { ApiResult } from "../../../api/client";
import type { DraftClient } from "../../../skills/draft-client";
import type { Changed, DraftSummary, ScanPreview } from "../../../skills/drafts-api";
import {
  deleteSiteDraftFile,
  getSiteDraft,
  putSiteDraftFile,
  readSiteDraftText,
  scanSiteDraft,
  type SiteDraft,
  type SiteDraftChanged,
} from "./catalog-edit";

export function siteDraftSummary(name: string, d: SiteDraft): DraftSummary {
  return {
    id: d.skillId,
    name,
    shared: true,
    mine: true,
    ownerUserId: "",
    startedFrom: "fork",
    parentRef: { versionId: d.baseVersionId },
    fromConversation: false,
    coEdited: false,
    rev: d.rev,
    sizeBytes: d.sizeBytes,
    fileCount: d.fileCount,
    createdAt: d.updatedAt,
    updatedAt: d.updatedAt,
    updatedBy: d.updatedBy,
  };
}

const changed =
  (name: string) =>
  (res: ApiResult<SiteDraftChanged>): ApiResult<Changed> =>
    res.ok
      ? { ...res, data: { rev: res.data.rev, draft: siteDraftSummary(name, res.data.draft) } }
      : res;

/** `name`: the catalog skill's (the draft keeps it). The id the editor passes is the skill's. */
export function siteDraftClient(name: string): DraftClient {
  return {
    get: async (skillId) => {
      const res = await getSiteDraft(skillId);
      return res.ok
        ? {
            ...res,
            data: { draft: siteDraftSummary(name, res.data.draft), files: res.data.files },
          }
        : res;
    },
    readText: (skillId, path) => readSiteDraftText(skillId, path),
    put: async (skillId, path, rev, text) =>
      changed(name)(await putSiteDraftFile(skillId, path, rev, text)),
    remove: async (skillId, path, rev) =>
      changed(name)(await deleteSiteDraftFile(skillId, path, rev)),
    share: () =>
      Promise.resolve({
        ok: false,
        error: { status: 0, code: "not_shared", message: "A site draft is always shared." },
      }),
    scan: (skillId, signal) => scanSiteDraft<ScanPreview>(skillId, signal),
  };
}

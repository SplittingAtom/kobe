/**
 * The workspace file browser API (KOBE-148, `/v1/workspace`) over the shared client. Every call
 * sends `X-Kobe-Team`, so a tab left on another team gets `team_mismatch`. The workspace is the
 * caller's own, so no call names an owner. Entries are camelized by the client.
 */
import type { SyncConflictView } from "./sync-conflicts";
import type { WorkspaceArea } from "@kobe/protocol";
import {
  apiDownload,
  apiReadCapped,
  apiRequest,
  type ApiResult,
  type CappedBytes,
} from "../api/client";

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "file" | "dir";
  readonly sizeBytes: number | null;
  readonly mtime: string;
  readonly source: "synced" | "live";
  readonly area: WorkspaceArea;
  /** The synced copy's version (KOBE-462); absent for folders and live-only files. */
  readonly sha256?: string | undefined;
}

export interface FolderListing {
  readonly path: string;
  readonly entries: readonly FileEntry[];
  /**
   * Next page. TODO(KOBE-184): the server returns this once its paging cursor lands (PR #150);
   * until then it is always absent and the listing is capped server side.
   */
  readonly nextCursor?: string | null;
}

/** What a move or rename did (KOBE-304): `to` is the full new path. */
export interface MoveResult {
  readonly from: string;
  readonly to: string;
  readonly type: "file" | "dir";
  readonly files: number;
}

export interface FileSearchResult {
  readonly entries: readonly FileEntry[];
}

export interface FilesApi {
  /** The team every call names (the tree remembers its folders per team, KOBE-304). */
  readonly teamId: string;
  list(path: string, cursor?: string, signal?: AbortSignal): Promise<ApiResult<FolderListing>>;
  /**
   * The caller's own synced files whose path contains `query` (KOBE-223, the composer's `@`
   * picker): names starting with it first, then newest; at most 50.
   */
  search(query: string, limit?: number, signal?: AbortSignal): Promise<ApiResult<FileSearchResult>>;
  download(path: string): Promise<ApiResult<Uint8Array>>;
  upload(folder: string, file: File): Promise<ApiResult<FileEntry>>;
  remove(path: string): Promise<ApiResult<void>>;
  /**
   * Moves or renames a file or folder to the full path `to` (KOBE-304). The server decides: a
   * clash is 409 `already_exists` (never overwritten), read-only areas 403 `read_only`.
   */
  move(from: string, to: string): Promise<ApiResult<MoveResult>>;
  /**
   * A file's first `maxBytes` for a preview (KOBE-268); the rest is never fetched. `wholeOnly`:
   * nothing is read when its size is over the cap (images; 0 = headers only, for the size and
   * whether it exists). 404 `not_found`: the file is gone.
   */
  read(path: string, maxBytes: number, wholeOnly?: boolean): Promise<ApiResult<CappedBytes>>;
  /**
   * The file editor's save (KOBE-463, spec FE4): replaces an existing file of the member's own
   * workspace with `text` when its synced copy still has `baseSha256` (the version the editor
   * loaded). 409 `version_conflict`: it changed or was deleted meanwhile; read-only areas 403.
   */
  save(path: string, baseSha256: string, text: string): Promise<ApiResult<FileEntry>>;
  /**
   * The caller's open sync conflicts no thread wrote (KOBE-492, `GET /v1/workspace/sync-conflicts`),
   * newest first: shown in the Files rail. Conflicts of a thread show in that thread.
   */
  syncConflicts(): Promise<ApiResult<{ readonly conflicts: readonly SyncConflictView[] }>>;
  /** Settles one of them: `resolved` (the copy was deleted) or `dismissed` (204). */
  settleSyncConflict(id: string, action: "resolved" | "dismissed"): Promise<ApiResult<void>>;
  /** The panel opened: start the sandbox so the next sync catches up (202, fire and forget). */
  wake(): Promise<ApiResult<{ readonly status: string }>>;
}

function query(params: Readonly<Record<string, string | undefined>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, value);
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

export function createFilesApi(teamId: string, fetchFn?: typeof fetch): FilesApi {
  const opts = { teamId, fetchFn };
  return {
    teamId,
    list: (path, cursor, signal) =>
      apiRequest(`/v1/workspace/files${query({ path, cursor })}`, { ...opts, signal }),
    search: (q, limit, signal) =>
      apiRequest(
        `/v1/workspace/files/search${query({ q, limit: limit === undefined ? undefined : String(limit) })}`,
        { ...opts, signal },
      ),
    read: (path, maxBytes, wholeOnly = false) =>
      apiReadCapped(`/v1/workspace/file${query({ path })}`, maxBytes, { ...opts, wholeOnly }),
    download: (path) => apiDownload(`/v1/workspace/file${query({ path })}`, opts),
    upload: (folder, file) => {
      const form = new FormData();
      form.set("path", folder);
      form.set("file", file, file.name);
      return apiRequest(`/v1/workspace/files`, { ...opts, method: "POST", form });
    },
    remove: (path) =>
      apiRequest(`/v1/workspace/files${query({ path })}`, { ...opts, method: "DELETE" }),
    move: (from, to) =>
      apiRequest(`/v1/workspace/files/move`, { ...opts, method: "POST", json: { from, to } }),
    save: (path, baseSha256, text) =>
      apiRequest(`/v1/workspace/file${query({ path, base_sha256: baseSha256 })}`, {
        ...opts,
        method: "PUT",
        raw: { body: new TextEncoder().encode(text), contentType: "text/plain; charset=utf-8" },
      }),
    wake: () => apiRequest(`/v1/workspace/wake`, { ...opts, method: "POST" }),
    syncConflicts: () => apiRequest(`/v1/workspace/sync-conflicts`, opts),
    settleSyncConflict: (id, action) =>
      apiRequest(`/v1/workspace/sync-conflicts/${encodeURIComponent(id)}`, {
        ...opts,
        method: "POST",
        json: { action },
      }),
  };
}

/**
 * The workspace file browser API (KOBE-148, `/v1/workspace`) over the shared client. Every call
 * sends `X-Kobe-Team`, so a tab left on another team gets `team_mismatch`. The workspace is the
 * caller's own, so no call names an owner. Entries are camelized by the client.
 */
import type { WorkspaceArea } from "@kobe/protocol";
import { apiDownload, apiRequest, type ApiResult } from "../api/client";

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "file" | "dir";
  readonly sizeBytes: number | null;
  readonly mtime: string;
  readonly source: "synced" | "live";
  readonly area: WorkspaceArea;
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

export interface FilesApi {
  list(path: string, cursor?: string): Promise<ApiResult<FolderListing>>;
  download(path: string): Promise<ApiResult<Uint8Array>>;
  upload(folder: string, file: File): Promise<ApiResult<FileEntry>>;
  remove(path: string): Promise<ApiResult<void>>;
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
    list: (path, cursor) =>
      apiRequest(`/v1/workspace/files${query({ path, cursor })}`, opts),
    download: (path) => apiDownload(`/v1/workspace/file${query({ path })}`, opts),
    upload: (folder, file) => {
      const form = new FormData();
      form.set("path", folder);
      form.set("file", file, file.name);
      return apiRequest(`/v1/workspace/files`, { ...opts, method: "POST", form });
    },
    remove: (path) =>
      apiRequest(`/v1/workspace/files${query({ path })}`, { ...opts, method: "DELETE" }),
    wake: () => apiRequest(`/v1/workspace/wake`, { ...opts, method: "POST" }),
  };
}

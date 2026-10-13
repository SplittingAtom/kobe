/**
 * The workspace file browser API (KOBE-148, `/v1/workspace`) over the shared client. Every call
 * sends `X-Kobe-Team`, so a tab left on another team gets `team_mismatch`. The workspace is the
 * caller's own, so no call names an owner. Entries are camelized by the client.
 */
import type { WorkspaceArea } from "@kobe/protocol";
import {
  apiDownload,
  apiReadCapped,
  apiRequest,
  type ApiResult,
  type CappedBytes,
} from "../api/client";
import { parentPath } from "./format";

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
  /** A file's first `maxBytes` for a preview (KOBE-268); the rest is never fetched. */
  read(path: string, maxBytes: number): Promise<ApiResult<CappedBytes>>;
  /** A file's entry from its folder's listing; null when it (or its folder) no longer exists. */
  stat(path: string): Promise<ApiResult<FileEntry | null>>;
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

/** Most listing pages `stat` reads before it gives up on finding the file. */
const STAT_MAX_PAGES = 10;

async function statIn(api: Pick<FilesApi, "list">, path: string) {
  let cursor: string | undefined;
  for (let page = 0; page < STAT_MAX_PAGES; page += 1) {
    const res = await api.list(parentPath(path), cursor);
    if (!res.ok)
      return res.error.status === 404 ? { ok: true as const, status: 200, data: null } : res;
    const found = res.data.entries.find((e) => e.path === path && e.type === "file");
    if (found) return { ok: true as const, status: 200, data: found };
    cursor = res.data.nextCursor ?? undefined;
    if (cursor === undefined) break;
  }
  return { ok: true as const, status: 200, data: null };
}

export function createFilesApi(teamId: string, fetchFn?: typeof fetch): FilesApi {
  const opts = { teamId, fetchFn };
  const list: FilesApi["list"] = (path, cursor) =>
    apiRequest(`/v1/workspace/files${query({ path, cursor })}`, opts);
  return {
    list,
    read: (path, maxBytes) => apiReadCapped(`/v1/workspace/file${query({ path })}`, maxBytes, opts),
    stat: (path) => statIn({ list }, path),
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

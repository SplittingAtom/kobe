/**
 * The team's thread folders (KOBE-536, spec TF3/TF4): `GET/POST /v1/thread-folders`, `PATCH/DELETE
 * /v1/thread-folders/{id}` and filing, `POST /v1/threads/{id}/file`. Folder answers are validated
 * against `@kobe/protocol` in wire casing before the client sees them; a folder name is untrusted
 * text and is only ever rendered as text.
 */
import {
  createThreadFolderRequestSchema,
  threadFolderSchema,
  threadFoldersResponseSchema,
  updateThreadFolderRequestSchema,
} from "@kobe/protocol";
import "../security/zod-jitless";
import { apiRequest, type ApiError, type ApiResult } from "../api/client";
import type { ThreadSummary } from "./types";

/** A team folder as the client holds it (camelCase). `threads`: the caller's count (TF4). */
export interface FolderView {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly position: number;
  readonly createdBy: string;
  readonly threads: number;
}

export interface FolderChange {
  readonly name?: string;
  /** null moves it to the top level. */
  readonly parentId?: string | null;
}

export interface FoldersApi {
  list(): Promise<ApiResult<readonly FolderView[]>>;
  create(name: string, parentId: string | null): Promise<ApiResult<FolderView>>;
  update(id: string, change: FolderChange): Promise<ApiResult<FolderView>>;
  remove(id: string): Promise<ApiResult<void>>;
  /** Files the thread in `folderId`, or takes it out of its folder (null). */
  file(threadId: string, folderId: string | null): Promise<ApiResult<ThreadSummary>>;
}

const enc = encodeURIComponent;

const MALFORMED: ApiError = {
  status: 0,
  code: "malformed_response",
  message: "The folders could not be read. Try again.",
};

const INVALID_NAME: ApiError = {
  status: 400,
  code: "invalid_request",
  message: "Give the folder a name of 1 to 80 characters on one line.",
};

/** The camelized answer back in wire casing, so the protocol's strict schema checks it. */
function wire(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const f = value as Record<string, unknown>;
  return {
    id: f.id,
    parent_id: f.parentId,
    name: f.name,
    position: f.position,
    created_by: f.createdBy,
    threads: f.threads,
  };
}

function view(f: {
  readonly id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly position: number;
  readonly created_by: string;
  readonly threads: number;
}): FolderView {
  return {
    id: f.id,
    parentId: f.parent_id,
    name: f.name,
    position: f.position,
    createdBy: f.created_by,
    threads: f.threads,
  };
}

function parseFolder(res: ApiResult<unknown>): ApiResult<FolderView> {
  if (!res.ok) return res;
  const parsed = threadFolderSchema.safeParse(wire(res.data));
  return parsed.success
    ? { ok: true, status: res.status, data: view(parsed.data) }
    : { ok: false, error: MALFORMED };
}

export function createFoldersApi(teamId: string, fetchFn?: typeof fetch): FoldersApi {
  const call = <T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, json?: unknown) =>
    apiRequest<T>(path, { method, json, teamId, fetchFn });
  return {
    async list() {
      const res = await call<unknown>("GET", "/v1/thread-folders");
      if (!res.ok) return res;
      const body = res.data as { folders?: unknown } | null;
      const parsed = threadFoldersResponseSchema.safeParse({
        folders: Array.isArray(body?.folders) ? body.folders.map(wire) : body?.folders,
      });
      return parsed.success
        ? { ok: true, status: res.status, data: parsed.data.folders.map(view) }
        : { ok: false, error: MALFORMED };
    },
    async create(name, parentId) {
      const body = createThreadFolderRequestSchema.safeParse({
        name,
        ...(parentId === null ? {} : { parent_id: parentId }),
      });
      if (!body.success) return { ok: false, error: INVALID_NAME };
      return parseFolder(await call("POST", "/v1/thread-folders", body.data));
    },
    async update(id, change) {
      const body = updateThreadFolderRequestSchema.safeParse({
        ...(change.name === undefined ? {} : { name: change.name }),
        ...(change.parentId === undefined ? {} : { parent_id: change.parentId }),
      });
      if (!body.success) return { ok: false, error: INVALID_NAME };
      return parseFolder(await call("PATCH", `/v1/thread-folders/${enc(id)}`, body.data));
    },
    remove: (id) => call("DELETE", `/v1/thread-folders/${enc(id)}`),
    file: (threadId, folderId) =>
      call<ThreadSummary>("POST", `/v1/threads/${enc(threadId)}/file`, { folder_id: folderId }),
  };
}

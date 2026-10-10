/**
 * Memory over the shared API client (`/v1/memory`, KOBE-155). Responses arrive camelized; request
 * bodies use the routes' snake_case. Personal memory is always the caller's own; project memory
 * needs `projectId`. Every call sends `X-Kobe-Team`.
 */
import { apiRequest, type ApiResult } from "../api/client";

export type MemoryScope = "user" | "project";

export interface MemoryDocSummary {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly path: string;
  readonly currentVersion: number;
  readonly sizeBytes: number;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

/** Where a version came from (the API's `source`): the agent, a panel edit, a restore or an approval. */
export type MemoryVersionSource = "agent" | "panel" | "restore" | "approval";

export interface MemoryVersionInfo {
  readonly version: number;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly source: MemoryVersionSource;
}

export interface MemoryDocDetail extends MemoryDocSummary {
  readonly content: string;
  readonly versions: readonly MemoryVersionInfo[];
}

export interface MemoryTarget {
  readonly scope: MemoryScope;
  readonly projectId?: string | undefined;
}

const enc = encodeURIComponent;

function withProject(target: MemoryTarget): string {
  return target.scope === "project" && target.projectId ? `&project_id=${enc(target.projectId)}` : "";
}

export interface MemoryApi {
  list(target: MemoryTarget): Promise<ApiResult<{ readonly docs: readonly MemoryDocSummary[] }>>;
  get(id: string): Promise<ApiResult<MemoryDocDetail>>;
  /** Writes `content` at `path`; `expectedVersion` makes a stale edit fail with 409. */
  put(
    target: MemoryTarget,
    path: string,
    content: string,
    expectedVersion?: number,
  ): Promise<ApiResult<MemoryDocDetail>>;
  /** Soft delete (204); a restore of an earlier version brings it back. */
  remove(id: string): Promise<ApiResult<void>>;
  /** Undo: a new version with the content of `version`. */
  restore(id: string, version: number): Promise<ApiResult<MemoryDocDetail>>;
}

export function createMemoryApi(teamId: string, fetchFn?: typeof fetch): MemoryApi {
  return {
    list: (target) =>
      apiRequest(`/v1/memory?scope=${target.scope}${withProject(target)}`, { teamId, fetchFn }),
    get: (id) => apiRequest(`/v1/memory/${enc(id)}`, { teamId, fetchFn }),
    put: (target, path, content, expectedVersion) =>
      apiRequest(`/v1/memory${target.scope === "project" && target.projectId ? `?project_id=${enc(target.projectId)}` : ""}`, {
        method: "PUT",
        json: {
          scope: target.scope,
          path,
          content,
          ...(expectedVersion === undefined ? {} : { expected_version: expectedVersion }),
        },
        teamId,
        fetchFn,
      }),
    remove: (id) => apiRequest(`/v1/memory/${enc(id)}`, { method: "DELETE", teamId, fetchFn }),
    restore: (id, version) =>
      apiRequest(`/v1/memory/${enc(id)}/restore`, {
        method: "POST",
        json: { version },
        teamId,
        fetchFn,
      }),
  };
}

/** The words for a failed memory call. */
export function describeMemoryError(error: { readonly status: number; readonly code: string; readonly message: string }): string {
  if (error.code === "memory_disabled") return "Memory is turned off for this team.";
  if (error.code === "version_conflict") return "This file changed since you opened it. Reload and try again.";
  if (error.code === "index_full") return "The memory index is full (200 lines). Remove something first.";
  if (error.status === 404) return "This memory file no longer exists.";
  return error.message;
}

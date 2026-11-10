/**
 * Thread–file links (spec thread-file-map, KOBE-612): which workspace files each thread read or
 * wrote, and which threads used a file. Three batched reads, validated here on the camelized answer:
 *
 * - `GET /v1/threads/file-links?threads=<id,...>` (at most 50 ids): the visible thread rows' links;
 * - `GET /v1/threads/{id}/files`: one thread's links;
 * - `GET /v1/workspace/file-threads?paths=<p,...>` (at most 100 paths): the threads per file.
 *
 * Paths are the workspace tree's (`GET /v1/workspace/files`; project files under
 * `projects/<slug>/…`). `hiddenCount` and `more` count what the viewer may not see by name (TFM7).
 *
 * TODO(KOBE-611): replace these local shapes with the `@kobe/protocol` schemas the server ticket
 * adds (threadFileLinks…/fileThreads…), keeping this module the only place that reads them.
 */
import { z } from "zod";
import "../security/zod-jitless";
import { apiRequest, type ApiError, type ApiResult } from "../api/client";

/** The most thread ids one `file-links` read takes. */
export const FILE_LINKS_MAX_THREADS = 50;
/** The most paths one `file-threads` read takes. */
export const FILE_THREADS_MAX_PATHS = 100;

export type FileAccess = "read" | "write";

const access = z.enum(["read", "write"]);

const linkedFile = z.object({
  path: z.string().min(1),
  projectId: z.string().nullable(),
  access,
  lastAt: z.string(),
  deleted: z.boolean(),
});

const threadLinks = z.object({
  threadId: z.string().min(1),
  files: z.array(linkedFile),
  hiddenCount: z.number().int().nonnegative(),
});

const fileLinksResponse = z.object({ links: z.array(threadLinks) });

const fileThread = z.object({
  threadId: z.string().min(1),
  title: z.string().nullable().optional(),
  access,
  lastAt: z.string(),
});

const fileThreads = z.object({
  path: z.string().min(1),
  threads: z.array(fileThread),
  more: z.number().int().nonnegative(),
});

const fileThreadsResponse = z.object({ files: z.array(fileThreads) });

/** One file a thread used. `deleted`: it is gone; listed as deleted, never in the rail. */
export type LinkedFile = z.infer<typeof linkedFile>;
/** A thread's links; `hiddenCount` files the viewer may not see by name (TFM7). */
export type ThreadFileLinks = z.infer<typeof threadLinks>;
/** One thread that used a file (`title` null: untitled). */
export type FileThread = z.infer<typeof fileThread>;
/** A file's threads; `more` threads the viewer may not read, or beyond the server's cap. */
export type FileThreads = z.infer<typeof fileThreads>;

export interface FileLinksApi {
  /** The links of up to {@link FILE_LINKS_MAX_THREADS} threads, in one read. */
  threadFileLinks(threadIds: readonly string[]): Promise<ApiResult<readonly ThreadFileLinks[]>>;
  /** One thread's links. */
  threadFileList(threadId: string): Promise<ApiResult<ThreadFileLinks>>;
  /** The threads of up to {@link FILE_THREADS_MAX_PATHS} paths, in one read. */
  fileThreads(paths: readonly string[]): Promise<ApiResult<readonly FileThreads[]>>;
}

const MALFORMED: ApiError = {
  status: 0,
  code: "malformed_response",
  message: "The thread's files could not be read. Try again.",
};

const TOO_MANY: ApiError = {
  status: 400,
  code: "invalid_request",
  message: "Too many at once.",
};

function parsed<T>(res: ApiResult<unknown>, schema: z.ZodType<T>): ApiResult<T> {
  if (!res.ok) return res;
  const out = schema.safeParse(res.data);
  return out.success
    ? { ok: true, status: res.status, data: out.data }
    : { ok: false, error: MALFORMED };
}

const list = (values: readonly string[]) => values.map(encodeURIComponent).join(",");

export function createFileLinksApi(teamId: string, fetchFn?: typeof fetch): FileLinksApi {
  const get = (path: string) => apiRequest<unknown>(path, { teamId, fetchFn });
  return {
    async threadFileLinks(threadIds) {
      if (threadIds.length === 0) return { ok: true, status: 200, data: [] };
      if (threadIds.length > FILE_LINKS_MAX_THREADS) return { ok: false, error: TOO_MANY };
      const res = parsed(
        await get(`/v1/threads/file-links?threads=${list(threadIds)}`),
        fileLinksResponse,
      );
      return res.ok ? { ...res, data: res.data.links } : res;
    },
    async threadFileList(threadId) {
      return parsed(await get(`/v1/threads/${encodeURIComponent(threadId)}/files`), threadLinks);
    },
    async fileThreads(paths) {
      if (paths.length === 0) return { ok: true, status: 200, data: [] };
      if (paths.length > FILE_THREADS_MAX_PATHS) return { ok: false, error: TOO_MANY };
      const res = parsed(
        await get(`/v1/workspace/file-threads?paths=${list(paths)}`),
        fileThreadsResponse,
      );
      return res.ok ? { ...res, data: res.data.files } : res;
    },
  };
}

/** Splits `values` into batches of at most `size`. */
export function batches<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

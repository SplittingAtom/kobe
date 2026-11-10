import { z } from "zod";
import { timestampSchema, uuidSchema } from "./common.js";
import { workspacePathSchema } from "./sandbox-wire/workspace-sync.js";

/**
 * Thread–file links (KOBE-611, spec docs/specs/thread-file-map.md §4, §6; decisions TFM1, TFM7):
 * which workspace files each thread read or wrote, as the server recorded them (KOBE-610).
 *
 * Paths are workspace-tree paths as `GET /v1/workspace/files` names them: the viewer's own files
 * relative to `/workspace`, project files under `projects/<slug>/…` (with `project_id`). A file has
 * access `write` if the thread ever wrote or changed it, else `read` (TFM1: solid vs dashed line).
 * `deleted`: the file is gone (shown as deleted in the thread's list, absent from the rail).
 *
 * Privacy (TFM7): only threads the viewer may read appear; a file is named only if it is in the
 * viewer's own workspace or in a project they can read. Everything else is counted, never named:
 * `hidden_count` (files of a thread) and `more` (threads of a file). In a thread a teammate shared,
 * that means project files by name and the teammate's own files as a count.
 *
 * Reads:
 * - `GET /v1/threads/file-links?threads=<id>,<id>…` (at most {@link THREAD_FILE_LINKS_MAX_THREADS}):
 *   the links of the visible thread rows in one call. Ids the viewer may not read are left out.
 * - `GET /v1/threads/{id}/file-links`: one thread's links (404 if the viewer may not read it).
 *   (Not `/files`: that path is KOBE-488's agent-written files for the badge row.)
 * - `GET /v1/workspace/file-threads?paths=<p>,<p>…` (at most {@link FILE_THREADS_MAX_PATHS}): the
 *   threads that used each path, newest first, at most {@link FILE_THREADS_MAX_THREADS} each; only
 *   live, listable threads (not in Trash, not test or eval threads) the viewer may read are named.
 *   A path may contain a comma: repeat the parameter (`paths=a&paths=b,c.md`); repeated values are
 *   taken whole, a single value is split on commas.
 */
export const THREAD_FILE_LINKS_MAX_THREADS = 50;
export const FILE_THREADS_MAX_PATHS = 100;
/** Files named per thread (newest first); any beyond count in `hidden_count`. */
export const THREAD_FILE_LINKS_MAX_FILES = 200;
/** Threads named per path (newest first); any beyond count in `more`. */
export const FILE_THREADS_MAX_THREADS = 20;

export const threadFileAccessSchema = z.enum(["read", "write"]);
export type ThreadFileAccessValue = z.infer<typeof threadFileAccessSchema>;

export const threadFileLinkSchema = z.strictObject({
  path: workspacePathSchema,
  project_id: uuidSchema.nullable(),
  access: threadFileAccessSchema,
  last_at: timestampSchema,
  deleted: z.boolean(),
});
export type ThreadFileLink = z.infer<typeof threadFileLinkSchema>;

export const threadFileLinksSchema = z.strictObject({
  thread_id: uuidSchema,
  files: z.array(threadFileLinkSchema).max(THREAD_FILE_LINKS_MAX_FILES),
  hidden_count: z.number().int().nonnegative(),
});
/** `GET /v1/threads/{id}/file-links`, and each entry of the batch. */
export type ThreadFileLinks = z.infer<typeof threadFileLinksSchema>;

export const threadFileLinksResponseSchema = z.strictObject({
  links: z.array(threadFileLinksSchema).max(THREAD_FILE_LINKS_MAX_THREADS),
});
export type ThreadFileLinksResponse = z.infer<typeof threadFileLinksResponseSchema>;

export const fileThreadSchema = z.strictObject({
  thread_id: uuidSchema,
  title: z.string().nullable(),
  access: threadFileAccessSchema,
  last_at: timestampSchema,
});
export type FileThread = z.infer<typeof fileThreadSchema>;

export const fileThreadsEntrySchema = z.strictObject({
  path: workspacePathSchema,
  threads: z.array(fileThreadSchema).max(FILE_THREADS_MAX_THREADS),
  more: z.number().int().nonnegative(),
});
export type FileThreadsEntry = z.infer<typeof fileThreadsEntrySchema>;

export const fileThreadsResponseSchema = z.strictObject({
  files: z.array(fileThreadsEntrySchema).max(FILE_THREADS_MAX_PATHS),
});
export type FileThreadsResponse = z.infer<typeof fileThreadsResponseSchema>;

/** A list parameter's values: repeated values taken whole, a single value split on commas. */
export function listParameter(values: readonly string[]): string[] {
  const items = values.length === 1 ? (values[0] ?? "").split(",") : [...values];
  return [...new Set(items)];
}

/** The `threads` query of `GET /v1/threads/file-links` (after {@link listParameter}). */
export const threadFileLinksQuerySchema = z.strictObject({
  threads: z.array(uuidSchema).min(1).max(THREAD_FILE_LINKS_MAX_THREADS),
});

/** The `paths` query of `GET /v1/workspace/file-threads` (after {@link listParameter}). */
export const fileThreadsQuerySchema = z.strictObject({
  paths: z.array(workspacePathSchema).min(1).max(FILE_THREADS_MAX_PATHS),
});

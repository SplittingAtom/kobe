import { z } from "zod";
import { idSchema, timestampSchema } from "./common.js";
import {
  UPLOAD_DEFAULT_MAX_FILE_BYTES,
  uploadFileNameSchema,
  uploadResponseSchema,
} from "./uploads.js";
import {
  sha256HexSchema,
  workspaceOriginSchema,
  workspacePathSchema,
} from "./sandbox-wire/workspace-sync.js";

/**
 * Files contract (KOBE-147 = 54a of KOBE-54; notes in docs/ledger/KOBE-147.md). Additive: an agent
 * without {@link CAPABILITY_FILES} never registers `share_file`, and no existing shape changes
 * (the `file.shared` event only gains the optional `description`).
 *
 * Two features, one `files` table (KOBE-142: kind `upload` | `shared`):
 * - the workspace file browser (REST, below) over the synced workspace and, for unsynced files,
 *   the live sandbox;
 * - `share_file`: the model hands a workspace file to the user as a download card.
 *
 * Push-then-share (normative). The server only has what the sandbox pushed through workspace sync
 * (sandbox-wire/workspace-sync.ts); it never reads the sandbox's disk for a share. Sequence:
 *  1. `share_file` runs through kobe-policy `policy.check` like any tool (`primary_arg` `/path`).
 *  2. kobe-tools sends `{op:"file.share"}` on fd 4 (`KOBE_TOOLS_FD`, artifacts.ts).
 *  3. The agent normalizes `input.path` to a workspace path (strip `/workspace/`), refuses paths
 *     outside the workspace, in `.kobe/`, or not a regular file, then **pushes that path**: hash,
 *     blob upload and workspace `commit` (a no-op commit is fine when the server already has the
 *     same hash). It waits for the result and keeps the applied entry (`rev`, `sha256`, `size`).
 *     A rejected or conflicting commit fails the tool with `not_synced`.
 *  4. The agent sends the `file.share` frame (frames.ts) with `workspace = {path, rev, sha256,
 *     size}` of that entry and waits for `file.share_result`.
 *  5. The server checks: capability announced; run active and leased; the allowed input for
 *     `tool_call_id` equals `input` (canonicalJson hash, as artifacts); the path's live row has
 *     exactly that `rev` and `sha256` (else `not_synced`: the file changed or was not pushed);
 *     size <= {@link FILE_SHARE_MAX_BYTES} (`too_large`); quota. It copies the blob into a new
 *     `files` row (kind `shared`, scan per config), emits `file.shared`, and answers. Idempotent
 *     on `(team_id, tool_call_id)`: a repeat returns the first result.
 *  6. The answer is the tool result. Later edits of the workspace file do not change the share.
 */

/** `hello.capabilities` entry of an agent that registers `share_file` and sends `file.share`. */
export const CAPABILITY_FILES = "files";

/** Largest file `share_file` accepts: the same as the default upload limit. */
export const FILE_SHARE_MAX_BYTES = UPLOAD_DEFAULT_MAX_FILE_BYTES;
export const FILE_SHARE_DESCRIPTION_MAX = 500;
export const FILE_SHARE_PATH_MAX = 1024;

// ----------------------------------------------------------------------------- REST: file browser

/** Areas of `/workspace`: the agent's own, and the two server-owned (read-only to the agent). */
export const WORKSPACE_AREAS = ["workspace", "uploads", "projects"] as const;
export const workspaceAreaSchema = z.enum(WORKSPACE_AREAS);
export type WorkspaceArea = z.infer<typeof workspaceAreaSchema>;

/** A folder path relative to `/workspace`; `""` is the root. */
const dirPath = z.union([z.literal(""), workspacePathSchema]);

/**
 * One row of the browser. `source`: `synced` = the server's workspace copy; `live` = only on the
 * running sandbox's disk, not pushed yet (listed when the sandbox is up; download goes through the
 * sandbox). `owner` is who may write it: `server` areas (uploads, projects) are read-only to the
 * agent. `size_bytes` is null for directories.
 */
export const workspaceFileEntrySchema = z
  .strictObject({
    name: z.string().min(1).max(255),
    path: workspacePathSchema,
    type: z.enum(["file", "dir"]),
    size_bytes: z.number().int().nonnegative().nullable(),
    mtime: timestampSchema,
    source: z.enum(["synced", "live"]),
    owner: workspaceOriginSchema,
    area: workspaceAreaSchema,
    sha256: sha256HexSchema.optional(),
    mime_type: z.string().min(1).max(255).optional(),
  })
  .refine((e) => (e.type === "dir") === (e.size_bytes === null), {
    message: "size_bytes is null exactly for directories",
    path: ["size_bytes"],
  });
export type WorkspaceFileEntry = z.infer<typeof workspaceFileEntrySchema>;

/** `GET /v1/threads/{id}/workspace/files?path=` (path absent = root) -> {@link workspaceListResponseSchema}. */
export const workspaceListQuerySchema = z.strictObject({ path: dirPath.optional() });
export const workspaceListResponseSchema = z.strictObject({
  path: dirPath,
  entries: z.array(workspaceFileEntrySchema),
});
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;

/**
 * `GET .../workspace/file?path=`: the bytes, `Content-Disposition: attachment`,
 * `X-Content-Type-Options: nosniff`, never inline.
 */
export const workspaceDownloadQuerySchema = z.strictObject({ path: workspacePathSchema });

/**
 * `POST .../workspace/files` (multipart/form-data): text field `path` = target folder (absent =
 * root), then one file part (name per `uploadFileNameSchema`). 201 body: the new
 * {@link workspaceFileEntrySchema}. Writes land in the synced copy; the agent receives them on its
 * next sync. Server-owned areas (`uploads/`, `projects/`) are refused (`read_only`).
 */
export const workspaceUploadFieldsSchema = z.strictObject({ path: dirPath.optional() });

/** `DELETE .../workspace/files?path=` -> 204. Files and directories; never the root. */
export const workspaceDeleteQuerySchema = z.strictObject({ path: workspacePathSchema });

export const WORKSPACE_FILE_ERROR_CODES = [
  "not_found",
  "invalid_path",
  "read_only",
  "already_exists",
  "file_too_large",
  "quota_exceeded",
  "sandbox_unavailable",
] as const;
export const workspaceFileErrorSchema = z.strictObject({
  code: z.enum(WORKSPACE_FILE_ERROR_CODES),
  message: z.string().max(2000),
});
export type WorkspaceFileError = z.infer<typeof workspaceFileErrorSchema>;

// ----------------------------------------------------------------------------- share_file tool

/** Model-facing input. `path` is absolute (`/workspace/...`) or relative to `/workspace`. */
export const shareFileInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(FILE_SHARE_PATH_MAX)
    // eslint-disable-next-line no-control-regex
    .refine((p) => !/[\u0000-\u001f\u007f]/u.test(p), "control character in path")
    .refine((p) => !p.split("/").includes(".."), "path traversal"),
  /** Download name; default = the file's name. */
  name: uploadFileNameSchema.optional(),
  description: z.string().min(1).max(FILE_SHARE_DESCRIPTION_MAX).optional(),
});
export type ShareFileInput = z.infer<typeof shareFileInputSchema>;

/**
 * Evidence of the push (step 3): the workspace entry the agent just committed. The server shares
 * only if the live row matches `rev` and `sha256`.
 */
export const shareFileWorkspaceRefSchema = z.strictObject({
  path: workspacePathSchema,
  rev: z.number().int().positive(),
  sha256: sha256HexSchema,
  size: z.number().int().nonnegative(),
});
export type ShareFileWorkspaceRef = z.infer<typeof shareFileWorkspaceRefSchema>;

/** The `files` record of a shared file: an upload's response plus its content hash. */
export const sharedFileSchema = uploadResponseSchema.extend({ sha256: sha256HexSchema });
export type SharedFile = z.infer<typeof sharedFileSchema>;

/** Success fields shared by the `file.share_result` frame and the kobe-tools response (flat). */
export const fileShareOkFields = { ok: z.literal(true), ...sharedFileSchema.shape } as const;

/** Server answer codes; open on the sandbox side (any `^[a-z][a-z0-9_]{0,63}$` decodes). */
export const FILE_SHARE_ERROR_CODES = [
  "not_allowed",
  "not_synced", // not pushed, changed since the push, or the push was rejected
  "not_found",
  "invalid_input",
  "too_large",
  "quota_exceeded",
  "scan_rejected",
  "storage_failed",
] as const;

/** `{ tool, input }` pair, as `artifactCallShape`. */
export const fileShareCallShape = {
  tool: z.literal("share_file"),
  input: shareFileInputSchema,
} as const;

/** kobe-tools request (fd 4) for `share_file`; member of `kobeToolsRequestSchema`. */
export const fileShareToolsRequestSchema = z.strictObject({
  id: idSchema,
  op: z.literal("file.share"),
  tool_call_id: idSchema,
  ...fileShareCallShape,
});

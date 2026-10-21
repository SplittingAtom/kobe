import { z } from "zod";
import { idSchema, timestampSchema, utf8ByteLength, uuidSchema } from "./common.js";
import { workspaceFileEntrySchema } from "./files.js";
import { sha256HexSchema, workspacePathSchema } from "./sandbox-wire/workspace-sync.js";

/**
 * File editor contract (KOBE-462; decisions FE1..FE12 in docs/specs/file-editor.md). Additive: an
 * agent without {@link CAPABILITY_FILE_EDITS} never registers `propose_file_edit` and never gets
 * `run.start.viewing`; old clients never send `viewing` and never call the save route.
 *
 * Three parts:
 * - the save route (REST, below): the member replaces a text file of their own workspace with the
 *   content their editor holds, given the version (SHA-256) the editor loaded; 409 on conflict;
 * - viewed-file context: a message may say which workspace file the member is looking at
 *   (`viewing`); the server adds a bounded, fenced, untrusted copy of it to that run's context;
 * - `propose_file_edit`: the model proposes a whole new content for a workspace file. It writes
 *   nothing; the server records the proposal as a `file.edit_proposed` run event and the member
 *   reviews it as a diff and commits (or not) through the save route.
 */

/** `hello.capabilities` entry of an agent that registers `propose_file_edit` and takes `run.start.viewing`. */
export const CAPABILITY_FILE_EDITS = "file_edits";
export const PROPOSE_FILE_EDIT_TOOL = "propose_file_edit";

/** Largest proposed content (UTF-8 bytes): the proposal travels whole in one run event. */
export const FILE_EDIT_CONTENT_MAX_BYTES = 128 * 1024;
export const FILE_EDIT_SUMMARY_MAX = 500;
/** Longest path the model may name (absolute `/workspace/...` or relative), as `share_file`. */
export const FILE_EDIT_PATH_MAX = 1024;
/** Bytes of the viewed file the run's context carries; the rest is cut (`truncated`). */
export const VIEWING_CONTENT_MAX_BYTES = 32 * 1024;

/** `/workspace/notes.md` or `notes.md` -> `notes.md`; undefined when it is not a workspace path. */
export function workspaceToolPath(path: string): string | undefined {
  const relative = path.startsWith("/workspace/") ? path.slice("/workspace/".length) : path;
  const parsed = workspacePathSchema.safeParse(relative);
  return parsed.success ? relative : undefined;
}

// ----------------------------------------------------------------------------- viewed file

/**
 * `submitMessageBodySchema.viewing` (run-orchestrator.ts): the workspace file the member has open
 * in the artifact column when sending. Only for the member's own messages; the server resolves it
 * in the sender's (= the thread owner's) workspace and never stores it in the message text.
 */
export const messageViewingSchema = z.strictObject({ path: workspacePathSchema });
export type MessageViewing = z.infer<typeof messageViewingSchema>;

/**
 * `run.start.viewing`: the viewed file as the server read it when the message was sent (the synced
 * copy). `content` is its first {@link VIEWING_CONTENT_MAX_BYTES} as text, absent when the file is
 * not text (not UTF-8, or holds NUL); `truncated` says the file is longer than `content`. The
 * agent fences it as untrusted data in that run's system prompt only.
 */
export const runViewingContextSchema = z.strictObject({
  path: workspacePathSchema,
  sha256: sha256HexSchema,
  size: z.number().int().nonnegative(),
  content: z
    .string()
    .refine((s) => utf8ByteLength(s) <= VIEWING_CONTENT_MAX_BYTES, "viewing content too large")
    .optional(),
  truncated: z.boolean(),
});
export type RunViewingContext = z.infer<typeof runViewingContextSchema>;

// ----------------------------------------------------------------------------- REST: save

/**
 * `PUT /v1/workspace/file?path=&base_sha256=`, body = the file's new bytes (any content type; the
 * editor sends `text/plain; charset=utf-8`), `Content-Length` required. Replaces an existing file
 * of the caller's own workspace when its synced copy still has `base_sha256` (the version the
 * editor loaded: `sha256` of the listing entry). Same path rules, size limit, workspace and team
 * quotas, team storage lock and audit (`workspace.file_saved`) as the browser upload; read-only
 * areas are refused (`read_only`). 200 body: the new {@link workspaceFileEntrySchema} (unchanged
 * content: the current entry, no new revision). 409 {@link workspaceSaveConflictSchema} when the
 * file changed or was deleted meanwhile. The sandbox receives the new content on its next sync.
 */
export const workspaceSaveQuerySchema = z.strictObject({
  path: workspacePathSchema,
  base_sha256: sha256HexSchema,
});
export type WorkspaceSaveQuery = z.infer<typeof workspaceSaveQuerySchema>;

export const workspaceSaveResponseSchema = workspaceFileEntrySchema;

/** The version a conflicting save found: null when the file no longer exists. */
export const workspaceSaveConflictSchema = z.strictObject({
  code: z.literal("version_conflict"),
  message: z.string().max(2000),
  current: z
    .strictObject({
      sha256: sha256HexSchema,
      size_bytes: z.number().int().nonnegative(),
      mtime: timestampSchema,
    })
    .nullable(),
});
export type WorkspaceSaveConflict = z.infer<typeof workspaceSaveConflictSchema>;

// ----------------------------------------------------------------------------- propose_file_edit

/** Model-facing input: the whole new content, never a patch (the web diffs). */
export const proposeFileEditInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(FILE_EDIT_PATH_MAX)
    // eslint-disable-next-line no-control-regex
    .refine((p) => !/[\u0000-\u001f\u007f]/u.test(p), "control character in path")
    .refine((p) => !p.split("/").includes(".."), "path traversal"),
  content: z
    .string()
    .refine((s) => utf8ByteLength(s) <= FILE_EDIT_CONTENT_MAX_BYTES, "content too large")
    .refine((s) => !s.includes("\u0000"), "U+0000"),
  /** One line for the member reviewing the diff: what the edit does. */
  summary: z.string().min(1).max(FILE_EDIT_SUMMARY_MAX),
});
export type ProposeFileEditInput = z.infer<typeof proposeFileEditInputSchema>;

export const fileEditToolInputSchema = {
  [PROPOSE_FILE_EDIT_TOOL]: proposeFileEditInputSchema,
} as const;

/** Server answer codes; open on the sandbox side (any `^[a-z][a-z0-9_]{0,63}$` decodes). */
export const FILE_EDIT_PROPOSE_ERROR_CODES = [
  "not_allowed",
  "invalid_path",
  "not_found", // no synced file there (not pushed yet, deleted, or agent-internal)
  "read_only", // project files and thread uploads
  "too_large",
  "storage_failed",
] as const;

export const fileEditProposeErrorSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  message: z.string().max(2000),
});

/** Success answer (frame and kobe-tools response, flat): nothing was written. */
export const fileEditProposeOkFields = {
  ok: z.literal(true),
  op: z.literal("file_edit_propose"),
  status: z.literal("awaiting_user"),
  /** The proposal's file, relative to `/workspace`. */
  path: workspacePathSchema,
  /** The synced version the proposal is based on (what the member's commit must still match). */
  base_sha256: sha256HexSchema,
} as const;
export const fileEditProposeFailFields = {
  ok: z.literal(false),
  error: fileEditProposeErrorSchema,
} as const;

export const fileEditCallShape = {
  tool: z.literal(PROPOSE_FILE_EDIT_TOOL),
  input: proposeFileEditInputSchema,
} as const;

/** kobe-tools request (fd 4); member of `kobeToolsRequestSchema`. */
export const fileEditToolsRequestSchema = z.strictObject({
  id: idSchema,
  op: z.literal("file.edit_propose"),
  tool_call_id: idSchema,
  ...fileEditCallShape,
});
export type FileEditToolsRequest = z.infer<typeof fileEditToolsRequestSchema>;

/**
 * The `file.edit_proposed` event payload: the server's record of the proposal (the web builds its
 * diff from this, never from the tool result the sandbox relays).
 */
export const fileEditProposedPayloadSchema = z.strictObject({
  tool_call_id: idSchema,
  path: workspacePathSchema,
  base_sha256: sha256HexSchema,
  content: z
    .string()
    .refine((s) => utf8ByteLength(s) <= FILE_EDIT_CONTENT_MAX_BYTES, "content too large"),
  summary: z.string().min(1).max(FILE_EDIT_SUMMARY_MAX),
});
export type FileEditProposedPayload = z.infer<typeof fileEditProposedPayloadSchema>;

/** Most proposals one listing answers (newest kept). */
export const FILE_EDIT_PROPOSALS_MAX = 200;

/**
 * `GET /v1/threads/{id}/file-edit-proposals` (thread owner only; others 404): the thread's
 * `file.edit_proposed` events, oldest first, newest {@link FILE_EDIT_PROPOSALS_MAX}. A run's
 * events are compacted 7 days after it ended (D18), and its proposals with them.
 */
export const fileEditProposalSchema = fileEditProposedPayloadSchema.extend({
  run_id: uuidSchema,
  created_at: timestampSchema,
});
export type FileEditProposal = z.infer<typeof fileEditProposalSchema>;

export const fileEditProposalsResponseSchema = z.strictObject({
  proposals: z.array(fileEditProposalSchema).max(FILE_EDIT_PROPOSALS_MAX),
});
export type FileEditProposalsResponse = z.infer<typeof fileEditProposalsResponseSchema>;

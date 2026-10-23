import { z } from "zod";
import { idSchema } from "./common.js";
import { fileEditProposeErrorSchema, proposeFileEditInputSchema } from "./file-editor.js";
import { workspacePathSchema } from "./sandbox-wire/workspace-sync.js";

/**
 * `open_file` (KOBE-484): the model asks the member's web client to open a workspace file in the
 * artifact column (text in the file editor, other types in their viewers). Server-decided and a
 * read: it writes nothing and carries no content. The agent pushes the file through workspace sync
 * first (so what opens is what the agent just wrote), then the server checks the path is a live
 * synced file of the run owner's own workspace and records a `file.opened` run event; the owner's
 * client opens the tab on that event. Rides the `file_edits` capability (file-editor.ts): an agent
 * that announced it registers `open_file`, and the server refuses `file.open` from one that did not.
 */
export const OPEN_FILE_TOOL = "open_file";

/** Model-facing input: one path under `/workspace` (absolute or relative), as `propose_file_edit`. */
export const openFileInputSchema = z.strictObject({
  path: proposeFileEditInputSchema.shape.path,
});
export type OpenFileInput = z.infer<typeof openFileInputSchema>;

export const fileOpenToolInputSchema = { [OPEN_FILE_TOOL]: openFileInputSchema } as const;

/** Server answer codes; open on the sandbox side (any `^[a-z][a-z0-9_]{0,63}$` decodes). */
export const FILE_OPEN_ERROR_CODES = [
  "not_allowed",
  "invalid_path",
  "not_found", // no such file in the workspace (or agent-internal)
  "not_synced", // the agent could not push it
  "storage_failed",
] as const;

/** Success answer (frame and kobe-tools response, flat): the owner's client opens `path`. */
export const fileOpenOkFields = {
  ok: z.literal(true),
  op: z.literal("file_open"),
  /** The opened file, relative to `/workspace`. */
  path: workspacePathSchema,
} as const;
export const fileOpenFailFields = {
  ok: z.literal(false),
  error: fileEditProposeErrorSchema,
} as const;

export const fileOpenCallShape = {
  tool: z.literal(OPEN_FILE_TOOL),
  input: openFileInputSchema,
} as const;

/** kobe-tools request (fd 4); member of `kobeToolsRequestSchema`. */
export const fileOpenToolsRequestSchema = z.strictObject({
  id: idSchema,
  op: z.literal("file.open"),
  tool_call_id: idSchema,
  ...fileOpenCallShape,
});
export type FileOpenToolsRequest = z.infer<typeof fileOpenToolsRequestSchema>;

/** The `file.opened` event payload: which file the owner's client opens. Never any content. */
export const fileOpenedPayloadSchema = z.strictObject({
  tool_call_id: idSchema,
  path: workspacePathSchema,
});
export type FileOpenedPayload = z.infer<typeof fileOpenedPayloadSchema>;

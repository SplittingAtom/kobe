import { z } from "zod";
import { workspaceFileEntrySchema } from "./files.js";

/**
 * `GET /v1/threads/{id}/files` (KOBE-488): the workspace files the agent wrote in this thread with
 * its file tools, for the badge row under the thread title. Additive contract; the thread's owner
 * only (anyone else gets 404: the files are in the owner's workspace).
 *
 * A path counts when Pi's `write` or `edit` succeeded on it (the run's `tool.call` and a
 * `tool.result` without error, or the thread's mirrored entries once the run's events are
 * compacted), or when a `propose_file_edit` proposal for it was accepted (the synced file holds
 * the proposed content). Paths are relative to `/workspace`, de-duplicated, in order of first
 * appearance, and only files that are still live in the owner's synced workspace (a deleted or
 * moved file drops out). Files made only by `bash` or `run_python` are not listed (no record of
 * what they wrote), nor a write whose input was too large to keep (`kobe_omitted`).
 */
export const THREAD_FILES_MAX = 200;

export const threadFilesResponseSchema = z.strictObject({
  files: z.array(workspaceFileEntrySchema).max(THREAD_FILES_MAX),
});
export type ThreadFilesResponse = z.infer<typeof threadFilesResponseSchema>;

/** Pi's file tools whose successful call wrote the file at `input.path`. */
export const THREAD_FILE_WRITE_TOOLS = ["write", "edit"] as const;

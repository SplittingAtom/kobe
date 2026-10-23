import { z } from "zod";
import { timestampSchema, uuidSchema } from "./common.js";
import { sha256HexSchema, workspacePathSchema } from "./sandbox-wire/workspace-sync.js";

/**
 * Workspace file changes for open file tabs (KOBE-496), additive. `GET /v1/workspace/changes`
 * is an SSE stream of the caller's **own** (team, user) workspace: the owner comes from the
 * session, so no parameter can name another member's files (as for every `/v1/workspace` route).
 *
 * Query: `team` (required: EventSource cannot send `X-Kobe-Team`; another active team answers 409
 * `team_mismatch`) and `path` once per open file, at most {@link WORKSPACE_CHANGES_MAX_PATHS}.
 * One stream per page serves its whole open tab set; a changed set opens a new stream.
 *
 * Framing: `event: file.state` once per requested path right after connecting (the catch-up:
 * the client compares `sha256` with the version each tab shows, so a change made while the
 * stream was down shows up after any reconnect), then `event: file.changed` whenever a requested
 * path gets a new revision. `data` is one {@link workspaceFileChangeSchema} JSON. Postgres is the
 * record; the server's LISTEN/NOTIFY hint only makes it re-read. Keep-alives and `retry:` as for
 * run streams (`sse.ts`).
 */
export const WORKSPACE_CHANGES_MAX_PATHS = 32;

export const WORKSPACE_CHANGE_EVENT_TYPES = ["file.state", "file.changed"] as const;
export type WorkspaceChangeEventType = (typeof WORKSPACE_CHANGE_EVENT_TYPES)[number];

/**
 * Who made the revision: `agent` = the member's sandbox pushed it (any of their threads or
 * schedules); `user` = the member themselves through the server (a save, upload, move or Edit as
 * file, from any browser tab or device); `sync` = the server keeping project files in line
 * (`name` is the member who added that project file, when known).
 */
export const workspaceChangeActorSchema = z.strictObject({
  kind: z.enum(["agent", "user", "sync"]),
  name: z.string().min(1).max(200).nullable(),
});
export type WorkspaceChangeActor = z.infer<typeof workspaceChangeActorSchema>;

export const workspaceFileChangeSchema = z.strictObject({
  path: workspacePathSchema,
  /** The current version; null when the file is not (or no longer) in the workspace. */
  sha256: sha256HexSchema.nullable(),
  /** The manifest revision of that version (0 for a path never seen). */
  rev: z.number().int().nonnegative(),
  /** Null for a path never seen. */
  actor: workspaceChangeActorSchema.nullable(),
  /** When that revision was written; null for a path never seen. */
  at: timestampSchema.nullable(),
});
export type WorkspaceFileChange = z.infer<typeof workspaceFileChangeSchema>;

export const workspaceChangesQuerySchema = z.strictObject({
  team: uuidSchema,
  path: z.array(workspacePathSchema).min(1).max(WORKSPACE_CHANGES_MAX_PATHS),
});
export type WorkspaceChangesQuery = z.infer<typeof workspaceChangesQuerySchema>;

/** One SSE message of the stream. `data` is always a single line. */
export function formatWorkspaceChange(
  type: WorkspaceChangeEventType,
  change: WorkspaceFileChange,
): string {
  return `event: ${type}\ndata: ${JSON.stringify(change)}\n\n`;
}

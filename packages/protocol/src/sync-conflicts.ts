import { z } from "zod";
import { timestampSchema, uuidSchema } from "./common.js";
import { sha256HexSchema, workspacePathSchema } from "./sandbox-wire/workspace-sync.js";

/**
 * Workspace sync conflicts (KOBE-492). When the member saves a file the agent also changed and
 * the agent's change was not pushed yet, the sandbox's next sync keeps the member's version at
 * `path` and moves the agent's to `conflict_path` (`<stem>.conflict-<UTC stamp>[-n]<ext>`, same
 * folder). The sandbox reports it (`workspace.conflict`, sandbox-wire/sync-conflict-frames.ts,
 * behind hello capability `sync_conflicts`); the server records it for the thread whose run last
 * wrote the path. The member sees a notice in that thread; the agent is told at its next model
 * call. Names and hashes only: never file content or diffs.
 */
export const CAPABILITY_SYNC_CONFLICTS = "sync_conflicts";

/** The basename of a conflict copy: `<stem>.conflict-YYYYMMDDTHHMMSSZ[-n]<ext>`. */
export const CONFLICT_COPY_PATTERN = /\.conflict-\d{8}T\d{6}Z(?:-\d{1,6})?(?:\.[^/]*)?$/u;

/** Most conflicts in one note to the agent (run.start or mid-run); older ones are summarised. */
export const SYNC_CONFLICT_NOTES_MAX = 5;
/** Most unresolved conflicts the thread route returns (newest). */
export const THREAD_SYNC_CONFLICTS_MAX = 20;

const dirOf = (path: string): string => {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
};

/**
 * Whether `copy` is a conflict copy of `path`: same folder, a conflict-copy basename, and not the
 * path itself.
 */
export function isConflictCopyOf(path: string, copy: string): boolean {
  if (path === copy || dirOf(path) !== dirOf(copy)) return false;
  const base = copy.slice(copy.lastIndexOf("/") + 1);
  return CONFLICT_COPY_PATTERN.test(base);
}

/** One conflict: both files (relative to `/workspace`) and their content hashes. */
export const syncConflictSchema = z
  .strictObject({
    path: workspacePathSchema,
    conflict_path: workspacePathSchema,
    /** The member's version, now at `path`. */
    member_sha256: sha256HexSchema,
    /** The agent's version, now at `conflict_path`. */
    agent_sha256: sha256HexSchema,
  })
  .refine((c) => isConflictCopyOf(c.path, c.conflict_path), {
    message: "conflict_path must be a conflict copy of path in the same folder",
    path: ["conflict_path"],
  });
export type SyncConflict = z.infer<typeof syncConflictSchema>;

/** `GET /v1/threads/{id}/sync-conflicts` (thread owner only; others 404): unresolved, newest first. */
export const threadSyncConflictSchema = z.strictObject({
  id: uuidSchema,
  path: workspacePathSchema,
  conflict_path: workspacePathSchema,
  member_sha256: sha256HexSchema,
  agent_sha256: sha256HexSchema,
  created_at: timestampSchema,
});
export type ThreadSyncConflict = z.infer<typeof threadSyncConflictSchema>;

export const threadSyncConflictsResponseSchema = z.strictObject({
  conflicts: z.array(threadSyncConflictSchema).max(THREAD_SYNC_CONFLICTS_MAX),
});
export type ThreadSyncConflictsResponse = z.infer<typeof threadSyncConflictsResponseSchema>;

/**
 * `POST /v1/threads/{id}/sync-conflicts/{conflict_id}` (owner only): `resolved` after the member
 * deleted the copy (or otherwise settled it), `dismissed` to hide the notice. 204; idempotent.
 */
export const syncConflictActionBodySchema = z.strictObject({
  action: z.enum(["resolved", "dismissed"]),
});
export type SyncConflictActionBody = z.infer<typeof syncConflictActionBodySchema>;

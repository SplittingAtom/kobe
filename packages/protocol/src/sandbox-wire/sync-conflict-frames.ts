import { z } from "zod";
import { timestampSchema, uuidSchema } from "../common.js";
import { SYNC_CONFLICT_NOTES_MAX, syncConflictSchema } from "../sync-conflicts.js";
import { SANDBOX_WIRE_VERSION } from "./connection.js";

/** A little over `WORKSPACE_PATH_MAX_BYTES` in UTF-16 units; the byte limit is checked after. */
const WIRE_PATH_MAX = 1024;

/** Sync conflict frames (KOBE-492, sync-conflicts.ts), behind hello capability `sync_conflicts`. */
function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ v: z.literal(SANDBOX_WIRE_VERSION), type: z.literal(type), ...shape });
}

/**
 * Sandbox -> server: one conflict the sync just resolved (the member's version kept, the agent's
 * moved to `conflict_path`). Not answered and never closing the connection: a frame the server
 * will not take (no capability, invalid, internal path, over the per-connection rate) is dropped
 * and logged. No run or thread: the server finds the thread whose run last wrote the path.
 */
export const workspaceConflictFrameSchema = frame("workspace.conflict", {
  // Bounded strings only: the server checks them with `syncConflictSchema` and the internal-path
  // rules and drops a frame that fails, so a bad name never closes the connection.
  path: z.string().max(WIRE_PATH_MAX),
  conflict_path: z.string().max(WIRE_PATH_MAX),
  member_sha256: z.string().max(64),
  agent_sha256: z.string().max(64),
  /** When the sandbox moved the copy (its clock; informational). */
  at: timestampSchema,
});

/**
 * Server -> sandbox: conflicts recorded for a thread whose run is active on this connection. The
 * agent adds a fenced Kobe notice before that run's next model call (Pi custom message: it reaches
 * the model in user role, never as the member's text, and is not stored in the session).
 */
export const workspaceConflictNoteFrameSchema = frame("workspace.conflict_note", {
  run_id: uuidSchema,
  thread_id: uuidSchema,
  conflicts: z.array(syncConflictSchema).min(1).max(SYNC_CONFLICT_NOTES_MAX),
});

export type WorkspaceConflictFrame = z.infer<typeof workspaceConflictFrameSchema>;
export type WorkspaceConflictNoteFrame = z.infer<typeof workspaceConflictNoteFrameSchema>;

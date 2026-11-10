import { z } from "zod";
import { uuidSchema } from "../common.js";
import { SANDBOX_WIRE_VERSION } from "./connection.js";

/**
 * Sync now (KOBE-599): the Files panel's Refresh asks the member's running sandbox to push its
 * local changes at once instead of at the next periodic push, then lists. Behind hello capability
 * {@link CAPABILITY_WORKSPACE_SYNC_NOW}: an agent that does not announce it never gets the frame,
 * and the server lists the last push at once.
 */
export const CAPABILITY_WORKSPACE_SYNC_NOW = "workspace_sync_now";

function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ v: z.literal(SANDBOX_WIRE_VERSION), type: z.literal(type), ...shape });
}

/**
 * Server -> sandbox: push every local change now. `request_id` is echoed in the answer. A frame
 * arriving while a push runs is answered after the next push, which starts after that one ends
 * (so a file written before the request is always in it); requests that wait together share one
 * push. No content, no paths.
 */
export const workspaceSyncNowFrameSchema = frame("workspace.sync_now", {
  request_id: uuidSchema,
});

/**
 * Sandbox -> server: the push asked for by `request_id` has finished (`ok`: committed, or there was
 * nothing to push; false: sync is off, still restoring, or the push failed). Never answered and
 * never closing the connection: an unknown or late `request_id` is dropped.
 */
export const workspaceSyncedFrameSchema = frame("workspace.synced", {
  request_id: uuidSchema,
  ok: z.boolean(),
});

export type WorkspaceSyncNowFrame = z.infer<typeof workspaceSyncNowFrameSchema>;
export type WorkspaceSyncedFrame = z.infer<typeof workspaceSyncedFrameSchema>;

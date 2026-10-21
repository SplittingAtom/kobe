import { z } from "zod";
import { idSchema, uuidSchema } from "../common.js";
import { threadContextResultSchema } from "../context-viewer.js";
import { SANDBOX_MAX_FRAME_BYTES, SANDBOX_WIRE_VERSION } from "./connection.js";

/**
 * `thread.context` (KOBE-470, context-viewer.ts): the server asks the member's own sandbox for the
 * context of a thread's latest model call, behind hello capability {@link CAPABILITY_THREAD_CONTEXT}.
 * Answered by `command.result` whose `data` is a `ThreadContextResult` (untrusted: the server
 * validates it). Never sent to a skill eval's sandbox.
 */
export const CAPABILITY_THREAD_CONTEXT = "thread_context";

/**
 * Most UTF-8 bytes of section text one answer carries. The agent also keeps the whole
 * `command.result` frame (JSON escaping included) under the frame cap.
 */
export const THREAD_CONTEXT_MAX_BYTES = 3 * 1024 * 1024;
/** What the agent leaves free in the frame for everything but the section texts. */
export const THREAD_CONTEXT_FRAME_MAX_BYTES = SANDBOX_MAX_FRAME_BYTES - 64 * 1024;

export const threadContextFrameSchema = z.strictObject({
  v: z.literal(SANDBOX_WIRE_VERSION),
  type: z.literal("thread.context"),
  command_id: idSchema,
  thread_id: uuidSchema,
  /** Budget for the section texts, in UTF-8 bytes. */
  max_bytes: z.number().int().positive().max(THREAD_CONTEXT_MAX_BYTES),
});
export type ThreadContextFrame = z.infer<typeof threadContextFrameSchema>;

/** What a successful `thread.context` returns in `command.result.data`. */
export const threadContextCommandResultSchema = threadContextResultSchema;

import { z } from "zod";
import { idSchema, uuidSchema } from "../common.js";
import { fileOpenCallShape, fileOpenFailFields, fileOpenOkFields } from "../file-open.js";
import { SANDBOX_WIRE_VERSION } from "./connection.js";

/** `open_file` frames (KOBE-484, file-open.ts), behind hello capability `file_edits`. */
function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ v: z.literal(SANDBOX_WIRE_VERSION), type: z.literal(type), ...shape });
}

/**
 * Sandbox -> server: the `open_file` call kobe-policy let through, sent after the agent pushed the
 * file through workspace sync. Answered by `file.open_result` for the same `request_id`.
 */
export const fileOpenFrameSchema = frame("file.open", {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  tool_call_id: idSchema,
  ...fileOpenCallShape,
});

/** Server -> sandbox; `error.code` is open (known: `FILE_OPEN_ERROR_CODES`). */
export const fileOpenResultFrameSchema = z.union([
  frame("file.open_result", { request_id: idSchema, ...fileOpenOkFields }),
  frame("file.open_result", { request_id: idSchema, ...fileOpenFailFields }),
]);

export type FileOpenFrame = z.infer<typeof fileOpenFrameSchema>;
export type FileOpenResultFrame = z.infer<typeof fileOpenResultFrameSchema>;

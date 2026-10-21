import { z } from "zod";
import { idSchema, uuidSchema } from "../common.js";
import {
  fileEditCallShape,
  fileEditProposeFailFields,
  fileEditProposeOkFields,
} from "../file-editor.js";
import { SANDBOX_WIRE_VERSION } from "./connection.js";

/** File edit frames (KOBE-462, file-editor.ts), behind hello capability `file_edits`. */
function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ v: z.literal(SANDBOX_WIRE_VERSION), type: z.literal(type), ...shape });
}

/**
 * Sandbox -> server: the `propose_file_edit` call kobe-policy let through. Nothing is pushed
 * first: the proposal is the input itself, and its base is the server's synced copy. Answered by
 * `file.edit_propose_result` for the same `request_id`.
 */
export const fileEditProposeFrameSchema = frame("file.edit_propose", {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  tool_call_id: idSchema,
  ...fileEditCallShape,
});

/** Server -> sandbox; `error.code` is open (known: `FILE_EDIT_PROPOSE_ERROR_CODES`). */
export const fileEditProposeResultFrameSchema = z.union([
  frame("file.edit_propose_result", { request_id: idSchema, ...fileEditProposeOkFields }),
  frame("file.edit_propose_result", { request_id: idSchema, ...fileEditProposeFailFields }),
]);

export type FileEditProposeFrame = z.infer<typeof fileEditProposeFrameSchema>;
export type FileEditProposeResultFrame = z.infer<typeof fileEditProposeResultFrameSchema>;

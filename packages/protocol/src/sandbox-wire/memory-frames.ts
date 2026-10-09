import { z } from "zod";
import { idSchema, uuidSchema } from "../common.js";
import {
  memoryFailFields,
  memoryPutOkFields,
  memoryReadOkFields,
  recallInputSchema,
  rememberInputSchema,
} from "../memory.js";
import { SANDBOX_WIRE_VERSION } from "./connection.js";

/** Memory frames (KOBE-153, memory.ts), behind hello capability `memory`. Same shape as `frame()` in frames.ts. */
function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ v: z.literal(SANDBOX_WIRE_VERSION), type: z.literal(type), ...shape });
}

/** Sandbox -> server: the `remember` call kobe-policy let through. Answered by `memory.result`. */
export const memoryPutFrameSchema = frame("memory.put", {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  tool_call_id: idSchema,
  input: rememberInputSchema,
});

/** Sandbox -> server: a `recall` call. Answered by `memory.result`. */
export const memoryReadFrameSchema = frame("memory.read", {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  input: recallInputSchema,
});

/** Server -> sandbox; `error.code` is open (known: `MEMORY_ERROR_CODES`). */
export const memoryResultFrameSchema = z.union([
  frame("memory.result", { request_id: idSchema, ...memoryPutOkFields }),
  frame("memory.result", { request_id: idSchema, ...memoryReadOkFields }),
  frame("memory.result", { request_id: idSchema, ...memoryFailFields }),
]);

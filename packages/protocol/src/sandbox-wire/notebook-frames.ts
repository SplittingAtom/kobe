import { z } from "zod";
import { idSchema, utf8ByteLength, uuidSchema } from "../common.js";
import {
  NOTEBOOK_CODE_MAX_BYTES,
  NOTEBOOK_EXEC_OUTPUTS_MAX,
  NOTEBOOK_TIMEOUT_MAX_S,
  notebookCallShape,
  notebookOutputSchema,
  notebookRunFailFields,
  notebookRunOkFields,
} from "../notebooks.js";
import { SANDBOX_WIRE_VERSION } from "./connection.js";

/**
 * Notebook frames (KOBE-464, notebooks.ts; docs/specs/notebooks.md), behind hello capability
 * `notebooks`. Three server commands (each answered with `command.result`), the outputs of a
 * running `notebook.execute`, and the `run_python` call kobe-policy let through.
 */
function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ v: z.literal(SANDBOX_WIRE_VERSION), type: z.literal(type), ...shape });
}

/**
 * Server -> sandbox: run `code` in the thread's kernel (started if it has none). Outputs come back
 * as `notebook.output` frames naming this `command_id`; `command.result.data` is a
 * `notebookExecuteResultSchema`. At `timeout_ms` the agent interrupts, then kills the kernel.
 */
export const notebookExecuteFrameSchema = frame("notebook.execute", {
  command_id: idSchema,
  thread_id: uuidSchema,
  run_id: uuidSchema,
  exec_id: uuidSchema,
  code: z
    .string()
    .min(1)
    .refine((s) => utf8ByteLength(s) <= NOTEBOOK_CODE_MAX_BYTES, "code too large"),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(NOTEBOOK_TIMEOUT_MAX_S * 1000),
});

/** Server -> sandbox: SIGINT the thread's kernel. `command.result.data`: `notebookKernelResultSchema`. */
export const notebookInterruptFrameSchema = frame("notebook.interrupt", {
  command_id: idSchema,
  thread_id: uuidSchema,
});

/**
 * Server -> sandbox: kill the thread's kernel (the next execution starts a fresh one). With
 * `op: "start"` (KOBE-477, capability `notebook_start`) instead start it if it has none, keeping a
 * live one; `command.result.data`: `notebookStartResultSchema`.
 */
export const notebookRestartFrameSchema = frame("notebook.restart", {
  command_id: idSchema,
  thread_id: uuidSchema,
  op: z.literal("start").optional(),
});

/** Sandbox -> server: the `index`-th output of the `notebook.execute` this `command_id` names. */
export const notebookOutputFrameSchema = frame("notebook.output", {
  command_id: idSchema,
  thread_id: uuidSchema,
  index: z
    .number()
    .int()
    .min(0)
    .max(NOTEBOOK_EXEC_OUTPUTS_MAX - 1),
  output: notebookOutputSchema,
});

/**
 * Sandbox -> server: the `run_python` call kobe-policy let through (a path was pushed first).
 * Answered by `notebook.run_result` for the same `request_id` once the execution ended.
 */
export const notebookRunFrameSchema = frame("notebook.run", {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  tool_call_id: idSchema,
  ...notebookCallShape,
});

/** Server -> sandbox; `error.code` is open (known: `NOTEBOOK_RUN_ERROR_CODES`). */
export const notebookRunResultFrameSchema = z.union([
  frame("notebook.run_result", { request_id: idSchema, ...notebookRunOkFields }),
  frame("notebook.run_result", { request_id: idSchema, ...notebookRunFailFields }),
]);

export type NotebookExecuteFrame = z.infer<typeof notebookExecuteFrameSchema>;
export type NotebookInterruptFrame = z.infer<typeof notebookInterruptFrameSchema>;
export type NotebookRestartFrame = z.infer<typeof notebookRestartFrameSchema>;
export type NotebookOutputFrame = z.infer<typeof notebookOutputFrameSchema>;
export type NotebookRunFrame = z.infer<typeof notebookRunFrameSchema>;
export type NotebookRunResultFrame = z.infer<typeof notebookRunResultFrameSchema>;

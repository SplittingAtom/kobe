import { z } from "zod";
import { idSchema, uuidSchema } from "../common.js";
import { artifactFailFields } from "../artifacts.js";
import {
  webSearchCallShape,
  webSearchOkFields,
  webSearchUnavailableFields,
} from "../web-search.js";
import { SANDBOX_WIRE_VERSION } from "./connection.js";

/** Web search frames (KOBE-114, web-search.ts), behind hello capability `web_search`. */
function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ v: z.literal(SANDBOX_WIRE_VERSION), type: z.literal(type), ...shape });
}

/**
 * Sandbox -> server: the `web_search` call kobe-policy let through. Answered by
 * `web_search.result` for the same `request_id`. A small frame.
 */
export const webSearchQueryFrameSchema = frame("web_search.query", {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  tool_call_id: idSchema,
  ...webSearchCallShape,
});

/** Server -> sandbox. */
export const webSearchResultFrameSchema = z.union([
  frame("web_search.result", { request_id: idSchema, ...webSearchOkFields }),
  frame("web_search.result", { request_id: idSchema, ...webSearchUnavailableFields }),
  frame("web_search.result", { request_id: idSchema, ...artifactFailFields }),
]);

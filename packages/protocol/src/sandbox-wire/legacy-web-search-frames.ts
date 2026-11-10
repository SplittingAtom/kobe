import { z } from "zod";
import { idSchema, uuidSchema } from "../common.js";
import { SANDBOX_WIRE_VERSION } from "./connection.js";

/**
 * Retired built-in web search (KOBE-114, removed by KOBE-606). Web search now comes through MCP
 * connectors. A sandbox image from before KOBE-606 may still announce the `web_search` capability
 * and send `web_search.query` while a release rolls out; the server takes the frame (so the
 * connection stays up) and answers every one `available: false`. Current agents never send it.
 * The result keeps the old shape and reason (`not_configured`) so an old agent accepts it.
 */
function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ v: z.literal(SANDBOX_WIRE_VERSION), type: z.literal(type), ...shape });
}

/** Sandbox -> server (legacy agents only): the input is not read, so it is not validated. */
export const legacyWebSearchQueryFrameSchema = frame("web_search.query", {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  tool_call_id: idSchema,
  tool: z.literal("web_search"),
  input: z.unknown(),
});

/** What the model of a legacy agent is told. */
export const LEGACY_WEB_SEARCH_MESSAGE =
  "Web search is not built into Kobe any more. Use a connector that offers search, if your team has one.";

/** Server -> sandbox: always unavailable. */
export const legacyWebSearchResultFrameSchema = frame("web_search.result", {
  request_id: idSchema,
  ok: z.literal(true),
  available: z.literal(false),
  reason: z.literal("not_configured"),
  message: z.string().max(500),
});

import { z } from "zod";

/**
 * zod schemas for what an MCP App may send Kobe's host bridge (KOBE-437, spec T4 and §7), after
 * the ext-apps specification (protocol 2026-01-26). Unknown fields are tolerated (forward
 * compatibility), but every field Kobe reads is typed and bounded.
 */
export const PROTOCOL_VERSION = "2026-01-26";

const id = z.union([z.string().max(128), z.number().int()]);

/** A JSON-RPC 2.0 request (with an id) from the app. */
export const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id,
  method: z.string().min(1).max(128),
  params: z.unknown().optional(),
});

/** A JSON-RPC 2.0 notification (no id) from the app. */
export const notificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1).max(128),
  params: z.unknown().optional(),
});

/** The app's answer to a request Kobe sent (only `ui/resource-teardown`). */
export const responseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id,
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

/** MCP tool names (the upstream's grammar). */
const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);

export const callToolParams = z.object({
  name: toolName,
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export const listToolsParams = z.object({ cursor: z.string().max(1024).optional() }).optional();

export const initializeParams = z
  .object({
    protocolVersion: z.string().max(64).optional(),
    appInfo: z.object({ name: z.string().max(256) }).optional(),
  })
  .optional();

const contentBlock = z.object({ type: z.string().max(64) });

export const messageParams = z.object({
  role: z.literal("user"),
  content: z.array(contentBlock.loose()).max(64),
});

export const modelContextParams = z.object({
  content: z.array(contentBlock.loose()).max(64).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

export const displayModeParams = z.object({ mode: z.enum(["inline", "fullscreen"]) });

const pixels = z.number().finite().nonnegative().max(100_000);
export const sizeChangedParams = z.object({
  width: pixels.optional(),
  height: pixels.optional(),
});

export type CallToolParams = z.infer<typeof callToolParams>;
export type ModelContext = z.infer<typeof modelContextParams>;
export type DisplayMode = z.infer<typeof displayModeParams>["mode"];
export type SizeChanged = z.infer<typeof sizeChangedParams>;

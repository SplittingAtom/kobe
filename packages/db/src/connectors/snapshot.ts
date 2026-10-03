import { z } from "zod";

/**
 * One pinned tool of a connector's `tools/list` snapshot (D27), as stored in
 * `connectors.tools_snapshot`. KOBE-59 writes snapshots (SHA-256 pin per tool, drift → `drifted`);
 * the MCP proxy (KOBE-58) serves `tools/list` from them, never from the live upstream, so a server
 * cannot change a description or schema under an agent without re-approval.
 *
 * Read side fails closed: an entry that does not parse is not offered and cannot be called.
 */

/** MCP tool names (2025-11-25): 1–128 of `[A-Za-z0-9_.-]`. */
export const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
/** Pi's name for a connector tool: `mcp__<server segment>__<tool segment>` (letters, digits, `_`). */
export const PI_TOOL_NAME_PATTERN = /^mcp__[A-Za-z0-9_]+__[A-Za-z0-9_]+$/;

const jsonObject = z.record(z.string(), z.unknown());

export const pinnedToolAnnotationsSchema = z.object({
  title: z.string().max(256).optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});

export const pinnedToolSchema = z.object({
  /** The upstream server's tool name (what `tools/call` names upstream). */
  name: z.string().regex(MCP_TOOL_NAME_PATTERN),
  /** The name Pi gives it (policy rules, approvals and audit use this one). */
  pi_name: z.string().max(256).regex(PI_TOOL_NAME_PATTERN),
  title: z.string().max(256).optional(),
  description: z.string().max(16_384).default(""),
  input_schema: jsonObject,
  output_schema: jsonObject.optional(),
  annotations: pinnedToolAnnotationsSchema.default({}),
  /** SHA-256 (hex) of the pinned name, description and schema. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** `drifted`: the live tool changed since it was pinned; disabled until re-approved (D27). */
  status: z.enum(["pinned", "drifted"]),
});
export type PinnedTool = z.infer<typeof pinnedToolSchema>;

/** The tools of a stored snapshot that parse; anything else is dropped (fail closed). */
export function parseToolsSnapshot(value: unknown): PinnedTool[] {
  if (!Array.isArray(value)) return [];
  const tools: PinnedTool[] = [];
  for (const entry of value) {
    const parsed = pinnedToolSchema.safeParse(entry);
    if (parsed.success) tools.push(parsed.data);
  }
  return tools;
}

import { createHash } from "node:crypto";
import { canonicalJson, mcpServerSegment } from "@kobe/protocol";
import { pinnedToolSchema, type PinnedTool } from "@kobe/db";
import { z } from "zod";

/**
 * Pinning (KOBE-101, spec D27 "rug-pull resistant tool surfaces"): turns a server's live
 * `tools/list` into the snapshot stored on `connectors.tools_snapshot`. Each tool is pinned by the
 * SHA-256 of the canonical JSON (RFC 8785 via `canonicalJson`) of exactly its name, description and
 * input schema, so key order and JSON whitespace never change a pin and any change to the three
 * fields does. Title, annotations and output schema are stored but not part of the pin.
 */

/** What a server may send per tool; unknown keys are dropped, malformed ones fail the snapshot. */
const listedToolSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
});

export interface PinInput {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: Record<string, unknown>;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** SHA-256 (hex) over the canonical form of `{description, inputSchema, name}`. */
export function toolHash(tool: PinInput): string {
  return sha256(
    canonicalJson({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    }),
  );
}

/** One hash over the whole snapshot: the sorted `(name, sha256)` pairs, so tool order is moot. */
export function snapshotHash(tools: readonly Pick<PinnedTool, "name" | "sha256">[]): string {
  const pairs = tools
    .map((t) => [t.name, t.sha256] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(canonicalJson(pairs));
}

export type PinFailure = "invalid_tool" | "ambiguous_tool_names";

export type SnapshotResult =
  | { readonly ok: true; readonly tools: PinnedTool[]; readonly hash: string }
  | { readonly ok: false; readonly failure: PinFailure };

const piToolSegment = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, "_");

/**
 * The snapshot for a connector from the raw `tools` of its `tools/list`. All or nothing: a tool
 * that does not parse, or names that Pi would treat as one tool (`get-x` / `get_x`, KOBE-58 review
 * L2), refuse the whole snapshot rather than pin a partial or ambiguous surface.
 */
export function buildSnapshot(connectorName: string, listed: readonly unknown[]): SnapshotResult {
  const server = mcpServerSegment(connectorName);
  const tools: PinnedTool[] = [];
  try {
    for (const raw of listed) {
      const tool = listedToolSchema.safeParse(raw);
      if (!tool.success) return { ok: false, failure: "invalid_tool" };
      const t = tool.data;
      const candidate = {
        name: t.name,
        pi_name: `mcp__${server}__${piToolSegment(t.name)}`,
        ...(t.title === undefined ? {} : { title: t.title }),
        description: t.description ?? "",
        input_schema: t.inputSchema,
        ...(t.outputSchema === undefined ? {} : { output_schema: t.outputSchema }),
        annotations: t.annotations ?? {},
        sha256: toolHash(t),
        status: "pinned" as const,
      };
      const pinned = pinnedToolSchema.safeParse(candidate);
      if (!pinned.success) return { ok: false, failure: "invalid_tool" };
      tools.push(pinned.data);
    }
  } catch {
    // canonicalJson refuses values JSON cannot carry (depth, non-finite numbers, ...).
    return { ok: false, failure: "invalid_tool" };
  }
  const distinct = (key: (t: PinnedTool) => string) =>
    new Set(tools.map(key)).size === tools.length;
  if (!distinct((t) => t.name) || !distinct((t) => t.pi_name)) {
    return { ok: false, failure: "ambiguous_tool_names" };
  }
  return { ok: true, tools, hash: snapshotHash(tools) };
}

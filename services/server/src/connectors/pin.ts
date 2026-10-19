import { createHash } from "node:crypto";
import { canonicalJson, mcpServerSegment } from "@kobe/protocol";
import {
  UI_RESOURCE_URI_PATTERN,
  pinnedToolSchema,
  type PinnedTool,
  type PinnedToolUi,
} from "@kobe/db";
import { z } from "zod";
import { schemaWithinLimits } from "./schema-limits.js";

/**
 * Pinning (KOBE-101, spec D27 "rug-pull resistant tool surfaces"): turns a server's live
 * `tools/list` into the snapshot stored on `connectors.tools_snapshot`. Each tool is pinned by the
 * SHA-256 of the canonical JSON (RFC 8785 via `canonicalJson`) of exactly its name, description and
 * input schema, so key order and JSON whitespace never change a pin and any change to the three
 * fields does. Title, annotations and output schema are stored but not part of the pin. A tool
 * that names an MCP Apps template (`_meta.ui.resourceUri`, KOBE-433) pins it too, so pointing the
 * tool at another template is drift; tools without one keep the hash they always had.
 */

/** What a server may send per tool; unknown keys are dropped, malformed ones fail the snapshot. */
const listedToolSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

const UI_URI_MAX = 2048;

/** The `ui://` template a listed tool names, if any (anything else is not an app). */
/**
 * A declared `_meta.ui.visibility` (KOBE-435, MA6), normalized: known values only, sorted, and
 * undefined when it is absent or says the default (`["model", "app"]`), so a server spelling out
 * the default is not drift. An array of nothing Kobe knows means visible to neither.
 *
 * A value that is present but not an array is malformed (review L4) and pins as `["model"]`:
 * the tool stays what it was before MCP Apps (offered to the model, as any host without apps
 * would) and gains no app access. Kobe does not reject it, because one malformed field would
 * then fail the whole snapshot and stop the connector's refresh and drift checks.
 */
function visibilityOf(value: unknown): PinnedToolUi["visibility"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return ["model"];
  const known = [
    ...new Set(value.filter((v): v is "app" | "model" => v === "app" || v === "model")),
  ].sort();
  return known.length === 2 ? undefined : known;
}

/** The pinned `_meta.ui` of a listed tool: its `ui://` template and visibility, if any. */
function uiOf(meta: Record<string, unknown> | undefined): PinnedToolUi | undefined {
  const ui = meta?.ui;
  if (typeof ui !== "object" || ui === null) return undefined;
  const declared = ui as Record<string, unknown>;
  const uri = declared.resourceUri;
  const resource =
    typeof uri === "string" && uri.length <= UI_URI_MAX && UI_RESOURCE_URI_PATTERN.test(uri)
      ? { resource_uri: uri }
      : {};
  const visibility = visibilityOf(declared.visibility);
  const pinned = { ...resource, ...(visibility === undefined ? {} : { visibility }) };
  return Object.keys(pinned).length === 0 ? undefined : pinned;
}

export interface PinInput {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: Record<string, unknown>;
  readonly ui?: PinnedToolUi | undefined;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** SHA-256 (hex) over the canonical form of `{description, inputSchema, name}` (and `ui`). */
export function toolHash(tool: PinInput): string {
  return sha256(
    canonicalJson({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      ...(tool.ui === undefined ? {} : { ui: tool.ui }),
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
      // Abusive schemas are refused before anyone can approve them (KOBE-436 review HIGH-1).
      if (!schemaWithinLimits(t.inputSchema)) return { ok: false, failure: "invalid_tool" };
      const ui = uiOf(t._meta);
      const candidate = {
        name: t.name,
        pi_name: `mcp__${server}__${piToolSegment(t.name)}`,
        ...(t.title === undefined ? {} : { title: t.title }),
        description: t.description ?? "",
        input_schema: t.inputSchema,
        ...(t.outputSchema === undefined ? {} : { output_schema: t.outputSchema }),
        annotations: t.annotations ?? {},
        ...(ui === undefined ? {} : { ui }),
        sha256: toolHash({ ...t, ui }),
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

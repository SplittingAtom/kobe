import { createHash } from "node:crypto";
import { z } from "zod";
import { KOBE_BUILTIN_CONNECTOR_URL, type PinnedTool } from "@kobe/db";
import type { EnabledConnector } from "../mcp/catalog.js";
import type { KobeBuiltinRow } from "./access.js";
import { zodOf, type KobeTool } from "./catalog.js";
import { KOBE_ADMIN_TOOLS } from "./tools/index.js";

/**
 * The Kobe catalog in the shape the MCP decision path already understands (KOBE-619): each tool as
 * a "pinned" tool of the built-in connector (annotations from the catalog, never drifted), and the
 * connector itself as a team connector with `custom` exposure over the tools the switches allow.
 * So `decideMcpCall` (policy engine, run checks, signed approvals, audit) decides Kobe calls with
 * no second implementation.
 */

const schemaOf = (type: z.ZodType) =>
  z.toJSONSchema(type, { target: "draft-2020-12", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;

export function kobePinnedTool(connectorName: string, tool: KobeTool): PinnedTool {
  const definition = {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    input_schema: schemaOf(zodOf(tool.input)),
    output_schema: schemaOf(zodOf(tool.output)),
  };
  return {
    ...definition,
    pi_name: `mcp__${connectorName.replace(/[^A-Za-z0-9_]/g, "_")}__${tool.name}`,
    annotations: tool.readOnly
      ? { title: tool.title, readOnlyHint: true, openWorldHint: false }
      : {
          title: tool.title,
          readOnlyHint: false,
          destructiveHint: tool.destructive,
          openWorldHint: false,
        },
    sha256: createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
    status: "pinned",
  };
}

export function kobePinnedTools(connectorName: string): PinnedTool[] {
  return KOBE_ADMIN_TOOLS.map((t) => kobePinnedTool(connectorName, t));
}

/** The built-in as a team connector: `custom` exposure over `enabled` (Pi names). */
export function kobeConnector(row: KobeBuiltinRow, enabled: readonly KobeTool[]): EnabledConnector {
  const tools = kobePinnedTools(row.name);
  const allowed = new Set(enabled.map((t) => t.name));
  return {
    id: row.id,
    name: row.name,
    url: KOBE_BUILTIN_CONNECTOR_URL,
    authKind: "none",
    credentialSource: "member",
    exposure: "custom",
    enabledTools: tools.filter((t) => allowed.has(t.name)).map((t) => t.pi_name),
    tools,
  };
}

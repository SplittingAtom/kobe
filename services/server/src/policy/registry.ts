import { builtinToolDescriptor, type ToolDescriptor, type ToolRegistry } from "@kobe/protocol";

/**
 * Pinned MCP tools of the team's connectors (D27), by Pi tool name. KOBE-59 implements it over the
 * connector registry's SHA-256-pinned snapshots (annotations → `riskFromAnnotations`,
 * `isOpenWorld`; `scope: "external"`). Until then no MCP tool resolves, so every MCP call is
 * denied as `unknown_tool` (fail closed).
 */
export interface McpToolCatalog {
  resolve(teamId: string, toolName: string): Promise<ToolDescriptor | undefined>;
}

export const NO_MCP_TOOLS: McpToolCatalog = { resolve: () => Promise.resolve(undefined) };

/**
 * The server's tool registry: Pi 1.0.0 built-ins and kobe-tools from `BUILTIN_TOOLS`, then MCP
 * tools from the pinned catalog. Anything else is unknown (the engine denies it). A catalog entry
 * that claims a built-in's name or a non-MCP source is ignored, so a connector can never
 * masquerade as a built-in.
 */
export function createToolRegistry(mcp: McpToolCatalog = NO_MCP_TOOLS): ToolRegistry {
  return {
    async resolve(teamId, toolName) {
      const builtin = builtinToolDescriptor(toolName);
      if (builtin) return builtin;
      if (!toolName.startsWith("mcp__")) return undefined;
      const tool = await mcp.resolve(teamId, toolName);
      if (tool?.name !== toolName || tool.source !== "mcp" || tool.connector_id === undefined) {
        return undefined;
      }
      return tool;
    },
  };
}

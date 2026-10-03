import {
  isOpenWorld,
  parseMcpToolName,
  riskFromAnnotations,
  type ToolAnnotations,
  type ToolDescriptor,
} from "@kobe/protocol";
import {
  and,
  connectors,
  eq,
  parseToolsSnapshot,
  sql,
  teamConnectors,
  withTeam,
  type ConnectorAuthKind,
  type ConnectorExposureKind,
  type KobeDb,
  type PinnedTool,
} from "@kobe/db";
import type { ConnectorStateSource } from "../policy/engine.js";
import type { ConnectorPolicyState } from "../policy/gates.js";
import type { McpToolCatalog } from "../policy/registry.js";

/**
 * Connector state as the MCP proxy core sees it (KOBE-58 minimal model over `connectors` and
 * `team_connectors`). KOBE-59 (registry, pinning, drift) and KOBE-60 (enablement) own the writes;
 * everything here reads, and fails closed: a tool that does not parse in the snapshot does not exist.
 */
export interface TeamConnector {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly authKind: ConnectorAuthKind;
  readonly exposure: ConnectorExposureKind;
  /** Pi tool names enabled under `custom` exposure. */
  readonly enabledTools: readonly string[];
  /** Pinned and drifted tools of the snapshot (drifted ones are never offered or callable). */
  readonly tools: readonly PinnedTool[];
}

/** The connector as enabled in `teamId`, or undefined (not registered, disabled, not enabled). */
export async function loadTeamConnector(
  db: KobeDb,
  teamId: string,
  connectorId: string,
): Promise<TeamConnector | undefined> {
  const [row] = await withTeam(db, teamId, (tx) =>
    tx
      .select({
        id: connectors.id,
        name: connectors.name,
        url: connectors.url,
        authKind: connectors.authKind,
        status: connectors.status,
        snapshot: connectors.toolsSnapshot,
        exposure: teamConnectors.exposure,
        enabledTools: teamConnectors.enabledTools,
      })
      .from(teamConnectors)
      .innerJoin(connectors, eq(connectors.id, teamConnectors.connectorId))
      .where(and(eq(teamConnectors.teamId, teamId), eq(teamConnectors.connectorId, connectorId))),
  );
  if (!row || row.status !== "active") return undefined;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    authKind: row.authKind,
    exposure: row.exposure,
    enabledTools: row.enabledTools,
    tools: parseToolsSnapshot(row.snapshot),
  };
}

/** The MCP annotation hints the D29 risk rule reads (snapshot annotations may carry a title). */
export function riskAnnotations(tool: PinnedTool): ToolAnnotations {
  const { readOnlyHint, destructiveHint, idempotentHint, openWorldHint } = tool.annotations;
  return {
    ...(readOnlyHint === undefined ? {} : { readOnlyHint }),
    ...(destructiveHint === undefined ? {} : { destructiveHint }),
    ...(idempotentHint === undefined ? {} : { idempotentHint }),
    ...(openWorldHint === undefined ? {} : { openWorldHint }),
  };
}

/** Server-derived descriptor of a pinned tool (D29: risk from the snapshot's annotations). */
export function describePinnedTool(connectorId: string, tool: PinnedTool): ToolDescriptor {
  const annotations = riskAnnotations(tool);
  return {
    name: tool.pi_name,
    source: "mcp",
    connector_id: connectorId,
    risk: riskFromAnnotations(annotations),
    open_world: isOpenWorld(annotations),
    scope: "external",
  };
}

/**
 * Tools a team's agents may see (D27 exposure): pinned only (drifted tools are disabled until
 * re-approved), and `read_only` = `readOnlyHint: true`, `all` = every pinned tool, `custom` = the
 * team's `enabled_tools`. Matches the engine's exposure gate (`policy/gates.ts`).
 */
export function exposedTools(connector: TeamConnector): PinnedTool[] {
  return connector.tools.filter((tool) => {
    if (tool.status !== "pinned") return false;
    if (connector.exposure === "all") return true;
    if (connector.exposure === "read_only") return tool.annotations.readOnlyHint === true;
    return connector.enabledTools.includes(tool.pi_name);
  });
}

/**
 * The policy engine's view of MCP connectors, from Postgres:
 * - `resolve(team, piName)`: the pinned tool whose Pi name it is, in the connector whose Pi server
 *   segment the name starts with (`mcp__<segment>__`; names differing only in `-`/`_` are one
 *   server, unique install-wide). Drifted tools resolve too, so the engine can say `tool_drifted`.
 * - `get(team, connectorId)`: enablement, exposure, custom tools and drifted tools in that team.
 */
export function createDbMcpCatalog(db: KobeDb): McpToolCatalog & ConnectorStateSource {
  return {
    async resolve(_teamId, toolName) {
      const parsed = parseMcpToolName(toolName);
      if (!parsed) return undefined;
      const [row] = await db
        .select({ id: connectors.id, snapshot: connectors.toolsSnapshot })
        .from(connectors)
        .where(sql`replace(${connectors.name}, '-', '_') = ${parsed.server_segment}`);
      if (!row) return undefined;
      const tool = parseToolsSnapshot(row.snapshot).find((t) => t.pi_name === toolName);
      return tool ? describePinnedTool(row.id, tool) : undefined;
    },
    async get(teamId, connectorId): Promise<ConnectorPolicyState | undefined> {
      const connector = await loadTeamConnector(db, teamId, connectorId);
      if (!connector) return undefined;
      return {
        enabled: true,
        exposure: connector.exposure,
        enabled_tools: [...connector.enabledTools],
        drifted_tools: connector.tools.filter((t) => t.status === "drifted").map((t) => t.pi_name),
      };
    },
  };
}

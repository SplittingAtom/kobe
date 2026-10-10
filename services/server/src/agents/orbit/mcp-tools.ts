import { withTeam, type KobeDb } from "@kobe/db";
import type { AgentDefinition } from "@kobe/agent-file";
import { buildRunMcp, loadTeamConnectorRows, type AgentToolGlobs } from "../../runs/run-mcp.js";
import type { ToolManifest } from "../manifest.js";

/**
 * The MCP tools of an agent version as the eval and the Orbit export must see them (KOBE-112):
 * the Kobe-normalized names `mcp__<server>__<tool>` of exactly what a run of this agent in this
 * team would be offered (same function as `run.start.mcp`, KOBE-111): the version's frozen
 * connectors, team-enabled and active, their pinned and undrifted tools under the team's exposure,
 * narrowed by the agent's tool globs. Names only: no URL, grant or credential is read or returned.
 * A user's grants are not applied: an export describes the agent's tool surface, not one user's.
 */
export async function orbitMcpToolNames(
  db: KobeDb,
  teamId: string,
  toolManifest: Pick<ToolManifest, "connectors">,
  agentTools: AgentDefinition["frontmatter"]["tools"],
): Promise<string[]> {
  if (toolManifest.connectors.length === 0) return [];
  const rows = await withTeam(db, teamId, (tx) => loadTeamConnectorRows(tx, teamId));
  const globs: AgentToolGlobs | undefined = agentTools;
  const { servers } = buildRunMcp(rows, toolManifest.connectors, globs);
  return servers.flatMap((s) => s.tools.map((t) => t.pi_name));
}

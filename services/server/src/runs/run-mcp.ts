import {
  and,
  connectorGrants,
  connectors,
  eq,
  parseToolsSnapshot,
  teamConnectors,
  type ConnectorCredentialSource,
  type ConnectorGrantKind,
  type KobeTx,
} from "@kobe/db";
import { matchGlob, type RunMcpContext } from "@kobe/protocol";
import { usableSiteKeyIds } from "../connectors/site-key.js";
import { exposedTools, type TeamConnector } from "../mcp/catalog.js";

/**
 * Which connectors a run really has (KOBE-111, 62a of KOBE-62): the replacement of the resolver's
 * `TODO(KOBE-61)` stub. A connector is effective when it is team-exposed (KOBE-104/106), the run's
 * user has a usable grant (an API key, or an OAuth grant whose access token has not expired;
 * KOBE-110 refreshes) or the connector has a usable site-wide key (KOBE-303, KOBE-449), and the
 * agent's tool list allows at least one of its exposed tools. The
 * proxy still re-checks every call (second enforcement point); this decides what Pi is told.
 */

/** A grant as far as "usable" needs it: no sealed bytes are read here. */
export interface GrantFact {
  readonly connectorId: string;
  readonly kind: ConnectorGrantKind;
  readonly expiresAt: Date | null;
}

/** The agent's `tools.allow` / `tools.deny` globs (frontmatter), matched against Pi tool names. */
export interface AgentToolGlobs {
  readonly allow?: readonly string[] | undefined;
  readonly deny?: readonly string[] | undefined;
}

/** A team connector with whose key members call it: their own, or the site's (KOBE-303). */
export interface RunConnectorRow extends TeamConnector {
  readonly credentialSource: ConnectorCredentialSource;
}

/** Active connectors the team enabled, in the shape the MCP proxy core uses. */
export async function loadTeamConnectorRows(
  tx: KobeTx,
  teamId: string,
): Promise<RunConnectorRow[]> {
  const rows = await tx
    .select({
      id: connectors.id,
      name: connectors.name,
      url: connectors.url,
      authKind: connectors.authKind,
      credentialSource: connectors.credentialSource,
      snapshot: connectors.toolsSnapshot,
      exposure: teamConnectors.exposure,
      enabledTools: teamConnectors.enabledTools,
    })
    .from(teamConnectors)
    .innerJoin(connectors, eq(connectors.id, teamConnectors.connectorId))
    .where(and(eq(teamConnectors.teamId, teamId), eq(connectors.status, "active")));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    authKind: r.authKind,
    credentialSource: r.credentialSource,
    exposure: r.exposure,
    enabledTools: r.enabledTools,
    tools: parseToolsSnapshot(r.snapshot),
  }));
}

/** The user's grants in this team (no secret columns are selected). */
export async function loadUserGrantFacts(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<GrantFact[]> {
  return tx
    .select({
      connectorId: connectorGrants.connectorId,
      kind: connectorGrants.kind,
      expiresAt: connectorGrants.expiresAt,
    })
    .from(connectorGrants)
    .where(and(eq(connectorGrants.teamId, teamId), eq(connectorGrants.userId, userId)));
}

/** The `site` connectors of `rows` whose site key is usable now (the proxy's own check). */
export function loadUsableSiteKeys(
  tx: KobeTx,
  rows: readonly RunConnectorRow[],
): Promise<Set<string>> {
  return usableSiteKeyIds(
    tx,
    rows.filter((r) => r.credentialSource === "site").map((r) => r.id),
  );
}

const NO_SITE_KEYS: ReadonlySet<string> = new Set();

/**
 * Names of the team connectors the user can use right now: `none` needs no credential; a `site`
 * connector needs a usable site key (`siteKeys`, from {@link loadUsableSiteKeys}) and never a
 * member's grant; any other needs the user's own live grant of its kind. A skill eval passes no
 * grants and no site keys (KOBE-325/326).
 */
export function connectedConnectorNames(
  rows: readonly RunConnectorRow[],
  grants: readonly GrantFact[],
  now: Date,
  siteKeys: ReadonlySet<string> = NO_SITE_KEYS,
): string[] {
  const byConnector = new Map(grants.map((g) => [g.connectorId, g]));
  return rows
    .filter((c) => {
      if (c.authKind === "none") return true;
      if (c.credentialSource === "site") return siteKeys.has(c.id);
      const g = byConnector.get(c.id);
      if (g === undefined || g.kind !== c.authKind) return false;
      return g.kind !== "oauth" || g.expiresAt === null || g.expiresAt.getTime() > now.getTime();
    })
    .map((c) => c.name);
}

function allowedByAgent(piName: string, globs: AgentToolGlobs | undefined): boolean {
  if (globs?.deny?.some((g) => matchGlob(g, piName))) return false;
  return globs?.allow === undefined || globs.allow.some((g) => matchGlob(g, piName));
}

/**
 * `run.start.mcp` for the resolver's effective connector names: each with the tools the team
 * exposes (pinned, not drifted) that the agent's globs allow. A connector left with no tool is not
 * listed: Pi would only learn of a server it can use nothing from.
 */
export function buildRunMcp(
  rows: readonly TeamConnector[],
  effective: readonly string[],
  agentTools: AgentToolGlobs | undefined,
): RunMcpContext {
  const wanted = new Set(effective);
  const servers = rows
    .filter((c) => wanted.has(c.name))
    .map((c) => ({
      name: c.name,
      connector_id: c.id,
      tools: exposedTools(c)
        .filter((t) => allowedByAgent(t.pi_name, agentTools))
        .map((t) => ({ name: t.name, pi_name: t.pi_name })),
    }))
    .filter((s) => s.tools.length > 0);
  return { servers };
}

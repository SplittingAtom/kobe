import {
  and,
  connectorSiteKeys,
  connectorUiResources,
  connectors,
  eq,
  inArray,
  isNull,
  parseToolsSnapshot,
  teamConnectors,
  withTeam,
  type ConnectorAuthKind,
  type ConnectorCredentialSource,
  type KobeDb,
  type PinnedTool,
} from "@kobe/db";
import { urlSha256 } from "../connectors/site-key.js";
import { appVisible } from "../connectors/visibility.js";
import type { TeamConnector } from "../mcp/catalog.js";
import { loadUserGrantFacts, type GrantFact } from "../runs/run-mcp.js";
import { exposedToApps } from "./decide.js";
import { appIdOf } from "./app-id.js";

/**
 * Which MCP Apps a member has (KOBE-436, spec MA8 and §6). An app is a connector's pinned and
 * approved `ui://` template, live for the member only when all of these hold:
 * - the connector is active and enabled for the active team;
 * - a pinned (not drifted) tool of it names the template and is in the team's exposure (the
 *   opening tool);
 * - the template is pinned and approved (never drifted or unapproved bytes);
 * - the member can call the connector: `none` auth, a site-wide key that is set and still bound
 *   to the connector's URL (KOBE-303), or their own live grant of the connector's kind.
 * Otherwise the app does not exist for them.
 */
export interface MemberAppConnector extends TeamConnector {
  readonly credentialSource: ConnectorCredentialSource;
  readonly iconUrl: string | null;
}

export interface MemberApp {
  readonly appId: string;
  readonly connector: MemberAppConnector;
  readonly uri: string;
  readonly sha256: string;
  readonly html: string;
  /** The tool that opens it: one with no required arguments that apps may call, if any. */
  readonly tool: PinnedTool;
}

/** What `GET /v1/team/apps` shows: never the template bytes or a credential. */
export interface MemberAppView {
  readonly appId: string;
  readonly connectorId: string;
  readonly connectorName: string;
  readonly iconUrl: string | null;
  readonly tool: string;
  readonly title: string;
  readonly uri: string;
  readonly sha256: string;
}

export const viewOf = (app: MemberApp): MemberAppView => ({
  appId: app.appId,
  connectorId: app.connector.id,
  connectorName: app.connector.name,
  iconUrl: app.connector.iconUrl,
  tool: app.tool.name,
  title: app.tool.title ?? app.tool.annotations.title ?? app.tool.name,
  uri: app.uri,
  sha256: app.sha256,
});

async function enabledConnectors(
  db: KobeDb,
  teamId: string,
  userId: string,
): Promise<{ rows: MemberAppConnector[]; grants: GrantFact[] }> {
  return withTeam(db, teamId, async (tx) => {
    const rows = await tx
      .select({
        id: connectors.id,
        name: connectors.name,
        url: connectors.url,
        authKind: connectors.authKind,
        credentialSource: connectors.credentialSource,
        iconUrl: connectors.iconUrl,
        snapshot: connectors.toolsSnapshot,
        exposure: teamConnectors.exposure,
        enabledTools: teamConnectors.enabledTools,
      })
      .from(teamConnectors)
      .innerJoin(connectors, eq(connectors.id, teamConnectors.connectorId))
      .where(
        and(
          eq(teamConnectors.teamId, teamId),
          eq(connectors.status, "active"),
          isNull(connectors.deletedAt),
        ),
      );
    return {
      rows: rows.map((r) => ({
        id: r.id,
        name: r.name,
        url: r.url,
        authKind: r.authKind as ConnectorAuthKind,
        credentialSource: r.credentialSource,
        iconUrl: r.iconUrl,
        exposure: r.exposure,
        enabledTools: r.enabledTools,
        tools: parseToolsSnapshot(r.snapshot),
      })),
      grants: await loadUserGrantFacts(tx, teamId, userId),
    };
  });
}

/** Connectors whose site-wide key is set and bound to their current URL. */
async function liveSiteKeys(db: KobeDb, rows: readonly MemberAppConnector[]): Promise<Set<string>> {
  const ids = rows.filter((r) => r.credentialSource === "site").map((r) => r.id);
  if (ids.length === 0) return new Set();
  const keys = await db
    .select({ id: connectorSiteKeys.connectorId, boundTo: connectorSiteKeys.urlSha256 })
    .from(connectorSiteKeys)
    .where(inArray(connectorSiteKeys.connectorId, ids));
  const url = new Map(rows.map((r) => [r.id, r.url]));
  return new Set(keys.filter((k) => k.boundTo === urlSha256(url.get(k.id) ?? "")).map((k) => k.id));
}

/** MA8: whether the member can call the connector right now (no secret is opened). */
export function canCall(
  c: MemberAppConnector,
  grants: readonly GrantFact[],
  siteKeys: ReadonlySet<string>,
  now: Date,
): boolean {
  if (c.authKind === "none") return true;
  if (c.credentialSource === "site") return siteKeys.has(c.id);
  const g = grants.find((x) => x.connectorId === c.id);
  if (g === undefined || g.kind !== c.authKind) return false;
  return g.kind !== "oauth" || g.expiresAt === null || g.expiresAt.getTime() > now.getTime();
}

const requiredArgs = (t: PinnedTool): number => {
  const required = (t.input_schema as { required?: unknown }).required;
  return Array.isArray(required) ? required.length : 0;
};

/** The opening tool of `uri`: pinned, exposed, naming it; app-callable without arguments first. */
function openingTool(c: MemberAppConnector, uri: string): PinnedTool | undefined {
  const candidates = c.tools.filter(
    (t) => t.status === "pinned" && t.ui?.resource_uri === uri && exposedToApps(c, t),
  );
  const rank = (t: PinnedTool) =>
    (t.annotations.readOnlyHint === true && appVisible(t) ? 0 : 2) +
    (requiredArgs(t) === 0 ? 0 : 1);
  return [...candidates].sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : 1))[0];
}

/** Every app live for the member in the team (MA8), with its connector and approved bytes. */
export async function memberApps(
  db: KobeDb,
  teamId: string,
  userId: string,
  now: Date = new Date(),
): Promise<MemberApp[]> {
  const { rows, grants } = await enabledConnectors(db, teamId, userId);
  const siteKeys = await liveSiteKeys(db, rows);
  const callable = rows.filter((c) => canCall(c, grants, siteKeys, now));
  if (callable.length === 0) return [];
  const templates = await db
    .select({
      connectorId: connectorUiResources.connectorId,
      uri: connectorUiResources.uri,
      sha256: connectorUiResources.sha256,
      html: connectorUiResources.html,
    })
    .from(connectorUiResources)
    .where(
      and(
        inArray(
          connectorUiResources.connectorId,
          callable.map((c) => c.id),
        ),
        eq(connectorUiResources.status, "pinned"),
        eq(connectorUiResources.approved, true),
      ),
    )
    .orderBy(connectorUiResources.connectorId, connectorUiResources.uri);
  const byId = new Map(callable.map((c) => [c.id, c]));
  const apps: MemberApp[] = [];
  for (const t of templates) {
    const connector = byId.get(t.connectorId);
    const tool = connector ? openingTool(connector, t.uri) : undefined;
    if (!connector || !tool) continue;
    apps.push({
      appId: appIdOf(connector.id, t.uri),
      connector,
      uri: t.uri,
      sha256: t.sha256,
      html: t.html,
      tool,
    });
  }
  return apps;
}

/** One app by id, live for the member, or undefined. */
export async function memberApp(
  db: KobeDb,
  teamId: string,
  userId: string,
  appId: string,
): Promise<MemberApp | undefined> {
  return (await memberApps(db, teamId, userId)).find((a) => a.appId === appId);
}

/** The connector an app id names, site-wide (for auditing a refusal), or undefined. */
export async function appConnectorOf(db: KobeDb, appId: string): Promise<string | undefined> {
  const rows = await db
    .select({ connectorId: connectorUiResources.connectorId, uri: connectorUiResources.uri })
    .from(connectorUiResources);
  return rows.find((r) => appIdOf(r.connectorId, r.uri) === appId)?.connectorId;
}

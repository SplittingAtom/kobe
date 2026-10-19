import {
  and,
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
import { usableSiteKeyIds } from "../connectors/site-key.js";
import { servedTemplate } from "../connectors/template-store.js";
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

/** Connectors whose site-wide key is usable now (the proxy's own check, KOBE-303). */
function liveSiteKeys(db: KobeDb, rows: readonly MemberAppConnector[]): Promise<Set<string>> {
  return usableSiteKeyIds(
    db,
    rows.filter((r) => r.credentialSource === "site").map((r) => r.id),
  );
}

/** MA8: whether the member can call the connector right now (no secret is opened). */
export function canCall(
  c: MemberAppConnector,
  grants: readonly GrantFact[],
  siteKeys: ReadonlySet<string>,
): boolean {
  if (c.authKind === "none") return true;
  if (c.credentialSource === "site") return siteKeys.has(c.id);
  const g = grants.find((x) => x.connectorId === c.id);
  if (g === undefined || g.kind !== c.authKind) return false;
  // An expired OAuth access token may still refresh (MA8, review LOW-4): the grant's sealed bundle
  // says whether it can, and only the reveal at call time opens it, refreshes, or refuses
  // (`credential_unavailable`). So any grant of the connector's kind counts here.
  return true;
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

/** The apps of `callable` connectors: pinned, approved templates with an opening tool. */
async function appsOf(db: KobeDb, callable: readonly MemberAppConnector[]): Promise<MemberApp[]> {
  if (callable.length === 0) return [];
  const templates = await db
    .select({
      connectorId: connectorUiResources.connectorId,
      uri: connectorUiResources.uri,
      sha256: connectorUiResources.sha256,
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
      tool,
    });
  }
  return apps;
}

/** Every app live for the member in the team (MA8), with its connector (no template bytes). */
export async function memberApps(db: KobeDb, teamId: string, userId: string): Promise<MemberApp[]> {
  const { rows, grants } = await enabledConnectors(db, teamId, userId);
  const siteKeys = await liveSiteKeys(db, rows);
  return appsOf(
    db,
    rows.filter((c) => canCall(c, grants, siteKeys)),
  );
}

/** An app the member would have with a key of their own (MA8 "Add your key", KOBE-440). */
export interface MissingKeyApp {
  readonly connectorId: string;
  readonly connectorName: string;
  readonly title: string;
}

/**
 * Apps missing only because the member holds no key of their own for the connector: everything
 * else of MA8 holds (enabled, exposed, pinned and approved). A connector on the site-wide key
 * (KOBE-303) is not the member's to fix, so it gives no hint.
 */
export async function missingKeyApps(
  db: KobeDb,
  teamId: string,
  userId: string,
): Promise<MissingKeyApp[]> {
  const { rows, grants } = await enabledConnectors(db, teamId, userId);
  const own = rows.filter(
    (c) =>
      c.authKind !== "none" &&
      c.credentialSource !== "site" &&
      !canCall(c, grants, new Set<string>()),
  );
  return (await appsOf(db, own)).map((app) => ({
    connectorId: app.connector.id,
    connectorName: app.connector.name,
    title: viewOf(app).title,
  }));
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

/** The approved bytes of a member's app (only `/template` reads them; review LOW-3). */
export async function memberAppHtml(db: KobeDb, app: MemberApp): Promise<string | undefined> {
  return (await servedTemplate(db, app.connector.id, app.uri))?.html;
}

/**
 * appId → connectorId per database (review LOW-3): hits are served for a minute; a miss reads
 * the ids again (URIs only, no bytes). Callers are behind the per-member rate limit, and the
 * rate-limited path asks at most once a minute per member.
 */
const APP_ID_TTL_MS = 60_000;
const appIdCache = new WeakMap<KobeDb, { at: number; ids: Map<string, string> }>();

/** The connector an app id names, site-wide (for auditing a refusal), or undefined. */
export async function appConnectorOf(db: KobeDb, appId: string): Promise<string | undefined> {
  const cached = appIdCache.get(db);
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && age < APP_ID_TTL_MS && cached.ids.has(appId)) return cached.ids.get(appId);
  const rows = await db
    .select({ connectorId: connectorUiResources.connectorId, uri: connectorUiResources.uri })
    .from(connectorUiResources);
  const ids = new Map(rows.map((r) => [appIdOf(r.connectorId, r.uri), r.connectorId]));
  appIdCache.set(db, { at: Date.now(), ids });
  return ids.get(appId);
}

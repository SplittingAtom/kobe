import { z } from "zod";
import {
  CONNECTOR_CREDENTIAL_SOURCES,
  CONNECTOR_NAME_PATTERN,
  CONNECTOR_URL_MAX,
  connectorSiteKeys,
  connectorUiResources,
  and,
  asc,
  connectors,
  eq,
  isNull,
  sql,
  teams,
  withTeam,
  teamConnectors,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { dropConnectorGrants } from "./grants.js";
import { dropSiteKey } from "./site-key.js";
import { dropTemplates } from "./template-store.js";

/**
 * The site connector registry (KOBE-100, spec D6, D27): MCP servers a site admin registers.
 * This module owns the rows; probing and pinning tools (KOBE-101), team enablement (KOBE-104) and
 * credentials (KOBE-107/108) come later. Audit records ids, names and changed field names only:
 * a URL can carry a key in its query string, so it never leaves the table.
 */

export const AUTH_KINDS = ["none", "api_key", "oauth"] as const;
export const STATUSES = ["active", "disabled"] as const;

const nameSchema = z
  .string()
  .max(64)
  .regex(new RegExp(CONNECTOR_NAME_PATTERN), "lowercase letters and digits joined by - or _");
const urlSchema = z.string().trim().min(1).max(CONNECTOR_URL_MAX);
/** https only, no credentials: the browser loads it as an image for every admin. */
const iconSchema = z
  .string()
  .trim()
  .max(CONNECTOR_URL_MAX)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" && u.username === "" && u.password === "" && u.hash === "";
    } catch {
      return false;
    }
  }, "an https URL");

/** A site-wide key (KOBE-303) is for `api_key` connectors only. */
const SITE_NEEDS_API_KEY = "a site-wide key needs authKind api_key";

export const createSchema = z
  .strictObject({
    name: nameSchema,
    url: urlSchema,
    iconUrl: iconSchema.nullish(),
    authKind: z.enum(AUTH_KINDS).default("none"),
    credentialSource: z.enum(CONNECTOR_CREDENTIAL_SOURCES).default("member"),
  })
  .refine((v) => v.credentialSource === "member" || v.authKind === "api_key", SITE_NEEDS_API_KEY);

export const updateSchema = z
  .strictObject({
    name: nameSchema,
    url: urlSchema,
    iconUrl: iconSchema.nullable(),
    authKind: z.enum(AUTH_KINDS),
    status: z.enum(STATUSES),
    credentialSource: z.enum(CONNECTOR_CREDENTIAL_SOURCES),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "nothing to change")
  .refine(
    (v) => v.credentialSource !== "site" || v.authKind === undefined || v.authKind === "api_key",
    SITE_NEEDS_API_KEY,
  );

export type CreateInput = z.infer<typeof createSchema>;
export type UpdateInput = z.infer<typeof updateSchema>;
export type ChangedField = "name" | "url" | "iconUrl" | "authKind" | "status" | "credentialSource";

export interface ConnectorView {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly iconUrl: string | null;
  readonly authKind: (typeof AUTH_KINDS)[number];
  /** `site`: every member uses the site-wide key (KOBE-303); `member`: their own. */
  readonly credentialSource: (typeof CONNECTOR_CREDENTIAL_SOURCES)[number];
  /** The site key's masked hint (last four characters at most); null when none is set. */
  readonly siteKeyHint: string | null;
  /** The URL changed since the key was set (review M2): it is not used until re-entered. */
  readonly siteKeyStale: boolean;
  readonly status: (typeof STATUSES)[number];
  readonly toolCount: number;
  /** Tools disabled pending re-approval (KOBE-102). */
  readonly driftedCount: number;
  readonly templatesDriftedCount: number;
  /** Why the last periodic refresh was skipped (e.g. `auth_required`, KOBE-431); null when it ran. */
  readonly refreshSkipped: string | null;
  /** When the periodic refresh last probed it; null before the first pass. */
  readonly refreshedAt: Date | null;
  /** Why the last refresh did not check its MCP Apps templates (KOBE-433); site admins only. */
  readonly templatesSkipped: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const columns = {
  id: connectors.id,
  name: connectors.name,
  url: connectors.url,
  iconUrl: connectors.iconUrl,
  authKind: connectors.authKind,
  credentialSource: connectors.credentialSource,
  siteKeyStale: sql<boolean>`COALESCE((SELECT ${connectorSiteKeys.urlSha256} <> encode(sha256(convert_to(${connectors.url}, 'UTF8')), 'hex') FROM ${connectorSiteKeys} WHERE ${connectorSiteKeys.connectorId} = ${connectors.id}), false)`,
  siteKeyHint: sql<
    string | null
  >`(SELECT ${connectorSiteKeys.hint} FROM ${connectorSiteKeys} WHERE ${connectorSiteKeys.connectorId} = ${connectors.id})`,
  status: connectors.status,
  toolCount: sql<number>`jsonb_array_length(${connectors.toolsSnapshot})`.mapWith(Number),
  driftedCount:
    sql<number>`(SELECT count(*) FROM jsonb_array_elements(${connectors.toolsSnapshot}) AS t WHERE t->>'status' = 'drifted')`.mapWith(
      Number,
    ),
  /** MCP Apps templates awaiting review (KOBE-434). */
  templatesDriftedCount:
    sql<number>`(SELECT count(*) FROM ${connectorUiResources} WHERE ${connectorUiResources.connectorId} = ${connectors.id} AND ${connectorUiResources.status} = 'drifted')`.mapWith(
      Number,
    ),
  refreshSkipped: connectors.refreshSkipped,
  refreshedAt: connectors.refreshedAt,
  templatesSkipped: connectors.templatesSkipped,
  createdAt: connectors.createdAt,
  updatedAt: connectors.updatedAt,
} as const;

const live = isNull(connectors.deletedAt);

export async function listConnectors(db: KobeDb): Promise<ConnectorView[]> {
  return db.select(columns).from(connectors).where(live).orderBy(asc(connectors.name));
}

export async function getConnector(db: KobeDb, id: string): Promise<ConnectorView | undefined> {
  const [row] = await db
    .select(columns)
    .from(connectors)
    .where(and(eq(connectors.id, id), live));
  return row;
}

export type NameConflict = "name_taken" | "name_removed";

/** The conflicting row's state, for a precise message (a removed connector still holds its name). */
async function nameConflict(
  tx: KobeTx,
  name: string,
  exceptId?: string,
): Promise<NameConflict | undefined> {
  const rows = await tx
    .select({ id: connectors.id, deletedAt: connectors.deletedAt })
    .from(connectors)
    .where(sql`replace(${connectors.name}, '-', '_') = replace(${name}, '-', '_')`);
  const other = rows.find((r) => r.id !== exceptId);
  if (!other) return undefined;
  return other.deletedAt ? "name_removed" : "name_taken";
}

export async function createConnector(
  db: KobeDb,
  input: CreateInput & { readonly url: string },
  userId: string,
): Promise<{ ok: true; connector: ConnectorView } | { ok: false; error: NameConflict }> {
  return db.transaction(async (tx) => {
    const conflict = await nameConflict(tx, input.name);
    if (conflict) return { ok: false as const, error: conflict };
    const [row] = await tx
      .insert(connectors)
      .values({
        name: input.name,
        url: input.url,
        iconUrl: input.iconUrl ?? null,
        authKind: input.authKind,
        credentialSource: input.credentialSource,
        createdBy: userId,
      })
      .returning(columns);
    if (!row) throw new Error("connector insert returned no row");
    await recordAudit(tx, {
      action: "mcp.connector.registered",
      target: { connectorId: row.id, name: row.name, authKind: row.authKind },
    });
    return { ok: true as const, connector: row };
  });
}

export async function updateConnector(
  db: KobeDb,
  id: string,
  input: UpdateInput,
): Promise<
  | { ok: true; connector: ConnectorView }
  | { ok: false; error: NameConflict | "not_found" | "site_needs_api_key" }
> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(connectors)
      .where(and(eq(connectors.id, id), live))
      .for("update");
    if (!current) return { ok: false as const, error: "not_found" as const };
    // Asking for a site-wide key on a connector that will not be api_key is refused (review L4).
    if (input.credentialSource === "site" && (input.authKind ?? current.authKind) !== "api_key") {
      return { ok: false as const, error: "site_needs_api_key" as const };
    }
    if (input.name !== undefined && input.name !== current.name) {
      const conflict = await nameConflict(tx, input.name, id);
      if (conflict) return { ok: false as const, error: conflict };
    }
    const changed: ChangedField[] = [];
    const set: Partial<typeof connectors.$inferInsert> = {};
    if (input.name !== undefined && input.name !== current.name) {
      set.name = input.name;
      changed.push("name");
    }
    if (input.url !== undefined && input.url !== current.url) {
      set.url = input.url;
      // A different server: its tools were never reviewed, so the old pins must not carry over.
      set.toolsSnapshot = [];
      set.toolsHash = null;
      set.refreshSkipped = null;
      set.templatesSkipped = null;
      changed.push("url");
      // Its MCP Apps templates too (KOBE-433): nothing of the old server is ever rendered.
      await dropTemplates(tx, id);
      // Credentials were issued for the old server: drop them (users reconnect). Members' grants
      // go first, before any audit row of this transaction (see dropConnectorGrants).
      await dropConnectorGrants(db, id, current.name);
      await dropSiteKey(tx, { id, name: current.name }, "url_changed");
    }
    if (input.iconUrl !== undefined && input.iconUrl !== current.iconUrl) {
      set.iconUrl = input.iconUrl;
      changed.push("iconUrl");
    }
    if (input.authKind !== undefined && input.authKind !== current.authKind) {
      set.authKind = input.authKind;
      changed.push("authKind");
    }
    const source = nextSource(current, input);
    if (source !== current.credentialSource) {
      set.credentialSource = source;
      changed.push("credentialSource");
      // Never both (KOBE-303): a connector uses members' own keys or the site key.
      // A URL change above already dropped the grants (and wrote an audit row since).
      if (source === "site") {
        if (!changed.includes("url")) await dropConnectorGrants(db, id, current.name);
      } else await dropSiteKey(tx, { id, name: current.name }, "mode_changed");
    }
    if (input.status !== undefined && input.status !== current.status) {
      set.status = input.status;
      changed.push("status");
    }
    if (changed.length === 0) return { ok: true as const, connector: await view(tx, id) };
    await tx
      .update(connectors)
      .set({ ...set, updatedAt: sql`now()` })
      .where(eq(connectors.id, id));
    await recordAudit(tx, {
      action: "mcp.connector.updated",
      target: { connectorId: id, name: set.name ?? current.name, changed },
    });
    return { ok: true as const, connector: await view(tx, id) };
  });
}

/** The credential source after an edit: a connector that stops being `api_key` is per-member. */
function nextSource(
  current: { readonly authKind: string; readonly credentialSource: string },
  input: UpdateInput,
): (typeof CONNECTOR_CREDENTIAL_SOURCES)[number] {
  const authKind = input.authKind ?? current.authKind;
  if (authKind !== "api_key") return "member";
  return input.credentialSource ?? (current.credentialSource === "site" ? "site" : "member");
}

async function view(tx: KobeTx, id: string): Promise<ConnectorView> {
  const [row] = await tx.select(columns).from(connectors).where(eq(connectors.id, id));
  if (!row) throw new Error("connector vanished inside its transaction");
  return row;
}

/**
 * How many teams have the connector enabled. `team_connectors` is a team table, so the count walks
 * the teams (an install has few) one `withTeam` at a time; RLS never lets one query see them all.
 */
export async function countTeamsUsing(db: KobeDb, connectorId: string): Promise<number> {
  const all = await db.select({ id: teams.id }).from(teams);
  let used = 0;
  for (const team of all) {
    const rows = await withTeam(db, team.id, (tx) =>
      tx
        .select({ one: sql<number>`1` })
        .from(teamConnectors)
        .where(eq(teamConnectors.connectorId, connectorId))
        .limit(1),
    );
    if (rows.length > 0) used += 1;
  }
  return used;
}

export interface RemovalResult {
  readonly removed: true;
  /** Always true: the API never hard-deletes (a hard delete would cascade into team rows). */
  readonly soft: true;
  /** Teams that had it enabled when it was removed (informational; may lag a concurrent enable). */
  readonly teams: number;
}

/**
 * Removes a connector from the registry by soft delete only: `status=disabled` + `deleted_at`. A
 * hard delete would cascade into `team_connectors`, and a team enabling the connector concurrently
 * (KOBE-104) could lose its row. The row is locked, so concurrent removals serialize.
 *
 * Its secrets do not outlive it (KOBE-454): the sealed site key and every member's grant (API keys
 * and OAuth tokens, in every team) are deleted in the same transaction, so restoring the row by
 * hand or registering the server again never revives them. OAuth tokens are only deleted, not
 * revoked at the provider (Kobe has no revocation client). The MCP proxy caches no credential
 * (it asks the server per call), so the next call is refused. Audited with counts, never values.
 */
export async function removeConnector(db: KobeDb, id: string): Promise<RemovalResult | undefined> {
  const usedBy = await countTeamsUsing(db, id);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ name: connectors.name })
      .from(connectors)
      .where(and(eq(connectors.id, id), live))
      .for("update");
    if (!row) return undefined;
    await tx
      .update(connectors)
      .set({ status: "disabled", deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(connectors.id, id));
    // Grants first: they commit in their teams' own transactions while this one holds the row
    // and has written no audit row yet (it would hold the audit chain lock they need).
    const grants = await dropConnectorGrants(db, id, row.name);
    const siteKeyDropped = await dropSiteKey(tx, { id, name: row.name }, "connector_removed");
    await recordAudit(tx, {
      action: "mcp.connector.removed",
      target: {
        connectorId: id,
        name: row.name,
        soft: true,
        teams: usedBy,
        siteKeyDropped,
        grants,
      },
    });
    return { removed: true as const, soft: true as const, teams: usedBy };
  });
}

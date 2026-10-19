import {
  and,
  connectorUiResources,
  connectors,
  eq,
  inArray,
  isNull,
  parseProposedUiResource,
  sql,
  uiResourceMetaSchema,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { canonicalJson } from "@kobe/protocol";
import type { LiveTemplate, StoredTemplate } from "./templates.js";

/**
 * `connector_ui_resources` reads and writes (KOBE-433). Site-wide (no team data, no RLS). Pins and
 * drift are written under the connector's row lock by the callers (pinning.ts, refresh.ts).
 */

type Db = KobeDb | KobeTx;

const columns = {
  uri: connectorUiResources.uri,
  mimeType: connectorUiResources.mimeType,
  html: connectorUiResources.html,
  sha256: connectorUiResources.sha256,
  meta: connectorUiResources.meta,
  pinnedHash: connectorUiResources.pinnedHash,
  status: connectorUiResources.status,
  proposed: connectorUiResources.proposed,
};

type Row = Pick<typeof connectorUiResources.$inferSelect, keyof typeof columns>;

function toStored(row: Row): StoredTemplate {
  const meta = uiResourceMetaSchema.safeParse(row.meta);
  const proposed = row.proposed === null ? undefined : parseProposedUiResource(row.proposed);
  return {
    uri: row.uri,
    mimeType: row.mimeType,
    html: row.html,
    sha256: row.sha256,
    meta: meta.success ? meta.data : {},
    pinnedHash: row.pinnedHash,
    status: row.status === "pinned" ? "pinned" : "drifted",
    // A stored proposal that no longer parses still marks the row as changed (never "new").
    ...(row.proposed === null
      ? {}
      : { proposed: proposed ?? { invalid: "ui_resource_invalid" as const } }),
  };
}

/** A connector's templates (`forUpdate`: row locks, inside the drift transaction). */
export async function loadTemplates(
  db: Db,
  connectorId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<StoredTemplate[]> {
  const query = db
    .select(columns)
    .from(connectorUiResources)
    .where(eq(connectorUiResources.connectorId, connectorId))
    .orderBy(connectorUiResources.uri);
  const rows = options.forUpdate ? await query.for("update") : await query;
  return rows.map(toStored);
}

const values = (connectorId: string, t: StoredTemplate) => ({
  connectorId,
  uri: t.uri,
  mimeType: t.mimeType,
  html: t.html,
  sha256: t.sha256,
  meta: t.meta,
  pinnedHash: t.pinnedHash,
  status: t.status,
  proposed: t.proposed ?? null,
});

/** A first pin: the connector's templates become exactly these, approved by `pinnedBy`. */
export async function replacePinnedTemplates(
  tx: KobeTx,
  connectorId: string,
  templates: readonly LiveTemplate[],
  pinnedBy: string | undefined,
): Promise<void> {
  await tx.delete(connectorUiResources).where(eq(connectorUiResources.connectorId, connectorId));
  if (templates.length === 0) return;
  await tx.insert(connectorUiResources).values(
    templates.map((t) => ({
      ...values(connectorId, { ...t, status: "pinned" }),
      pinnedBy: pinnedBy ?? null,
    })),
  );
}

/** Removes every template of a connector (its URL changed: a different server). */
export async function dropTemplates(tx: KobeTx, connectorId: string): Promise<void> {
  await tx.delete(connectorUiResources).where(eq(connectorUiResources.connectorId, connectorId));
}

/**
 * Writes the outcome of a drift pass: deletes templates that went, upserts those that differ.
 * Returns whether anything changed in the table.
 */
export async function writeTemplateDrift(
  tx: KobeTx,
  connectorId: string,
  before: readonly StoredTemplate[],
  after: readonly StoredTemplate[],
): Promise<boolean> {
  const kept = new Set(after.map((t) => t.uri));
  const gone = before.map((t) => t.uri).filter((uri) => !kept.has(uri));
  const previous = new Map(before.map((t) => [t.uri, canonicalJson(values(connectorId, t))]));
  const differ = after.filter((t) => previous.get(t.uri) !== canonicalJson(values(connectorId, t)));
  if (gone.length > 0) {
    await tx
      .delete(connectorUiResources)
      .where(
        and(
          eq(connectorUiResources.connectorId, connectorId),
          inArray(connectorUiResources.uri, gone),
        ),
      );
  }
  for (const t of differ) {
    const row = values(connectorId, t);
    const { connectorId: _c, uri: _u, ...set } = row;
    await tx
      .insert(connectorUiResources)
      .values(row)
      .onConflictDoUpdate({
        target: [connectorUiResources.connectorId, connectorUiResources.uri],
        set: { ...set, updatedAt: sql`now()` },
      });
  }
  return gone.length > 0 || differ.length > 0;
}

export interface ServedTemplate {
  readonly uri: string;
  readonly mimeType: string;
  readonly html: string;
  readonly sha256: string;
}

/**
 * The template Kobe may render: pinned (never drifted), of an active, not deleted connector.
 * Visibility to a member and the template's tool are checked by the callers (MA-4, MA-8).
 */
export async function servedTemplate(
  db: Db,
  connectorId: string,
  uri: string,
): Promise<ServedTemplate | undefined> {
  const [row] = await db
    .select({
      uri: connectorUiResources.uri,
      mimeType: connectorUiResources.mimeType,
      html: connectorUiResources.html,
      sha256: connectorUiResources.sha256,
    })
    .from(connectorUiResources)
    .innerJoin(connectors, eq(connectors.id, connectorUiResources.connectorId))
    .where(
      and(
        eq(connectorUiResources.connectorId, connectorId),
        eq(connectorUiResources.uri, uri),
        eq(connectorUiResources.status, "pinned"),
        eq(connectors.status, "active"),
        isNull(connectors.deletedAt),
      ),
    );
  return row;
}

/** URIs of templates awaiting review, per connector (notices and emails name them). */
export async function driftedTemplateUris(db: Db): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ connectorId: connectorUiResources.connectorId, uri: connectorUiResources.uri })
    .from(connectorUiResources)
    .where(eq(connectorUiResources.status, "drifted"))
    .orderBy(connectorUiResources.uri);
  const byConnector = new Map<string, string[]>();
  for (const { connectorId, uri } of rows) {
    byConnector.set(connectorId, [...(byConnector.get(connectorId) ?? []), uri]);
  }
  return byConnector;
}

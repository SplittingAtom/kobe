import { createHash } from "node:crypto";
import {
  Envelope,
  and,
  connectorSiteKeys,
  connectors,
  eq,
  inArray,
  isNull,
  sql,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { maskHint } from "./mask.js";

/**
 * A connector's site-wide API key (KOBE-303, extends D27 with the shared credential D32 lists as
 * "later"). A site admin sets one key for an `api_key` connector whose `credential_source` is
 * `site`; every member of a team that enabled the connector then calls it with that key, and no
 * member's own key is used. The key is sealed with the site envelope (KOBE-107) bound to the
 * connector, like `connector_grants`; no API returns it (the registry shows a masked hint); set,
 * replace and remove are audited without it. Only {@link revealSiteKey} opens it: for the MCP
 * proxy (through the internal grant endpoint, after the same liveness checks as a member's grant)
 * and for probes (pins, the refresh).
 */

/** A site-wide record has no team: the envelope binds to the nil team id (as web search does). */
const SITE_TEAM = "00000000-0000-0000-0000-000000000000";

/** SHA-256 (hex) of a connector URL: what a site key is bound to (review M2). */
export const urlSha256 = (url: string): string => createHash("sha256").update(url).digest("hex");

/** Envelope binding: the key opens only for this connector at this URL. */
export function siteKeyContext(connectorId: string, url: string) {
  return {
    teamId: SITE_TEAM,
    kind: "connector_site_key",
    recordId: `${connectorId}:${urlSha256(url)}`,
  } as const;
}

/**
 * What makes a stored site key usable (KOBE-303): the connector is live (not removed), in `site`
 * mode, `api_key` auth, and the key was set for the URL the connector has now (review M2). The one
 * definition shared by the proxy's reveal, probes, MCP Apps (MA8) and the run's connectors
 * (KOBE-449). Fails closed: a URL that changed by any path, an older release that knows nothing
 * of site keys included, leaves no usable key.
 */
const usableSiteKeyRows = (db: KobeDb | KobeTx, connectorIds: readonly string[]) =>
  db
    .select({
      connectorId: connectorSiteKeys.connectorId,
      sealed: connectorSiteKeys.sealed,
      boundTo: connectorSiteKeys.urlSha256,
      url: connectors.url,
    })
    .from(connectorSiteKeys)
    .innerJoin(connectors, eq(connectors.id, connectorSiteKeys.connectorId))
    .where(
      and(
        inArray(connectorSiteKeys.connectorId, [...connectorIds]),
        eq(connectors.credentialSource, "site"),
        eq(connectors.authKind, "api_key"),
        isNull(connectors.deletedAt),
      ),
    )
    .then((rows) => rows.filter((r) => r.boundTo === urlSha256(r.url)));

/**
 * Which of `connectorIds` have a usable site key right now, without opening any secret: what
 * "a member can call it with the site key" means for MA8 and for a run's connectors (KOBE-449).
 * The reveal may still fail on a ciphertext that does not open; the proxy then refuses the call.
 */
export async function usableSiteKeyIds(
  db: KobeDb | KobeTx,
  connectorIds: readonly string[],
): Promise<Set<string>> {
  if (connectorIds.length === 0) return new Set();
  return new Set((await usableSiteKeyRows(db, connectorIds)).map((r) => r.connectorId));
}

/**
 * The connector's site key, if it is usable ({@link usableSiteKeyRows}) and its ciphertext opens
 * (another envelope key or tampering is no key).
 */
export async function revealSiteKey(
  db: KobeDb | KobeTx,
  envelope: Envelope,
  connectorId: string,
): Promise<string | undefined> {
  const [row] = await usableSiteKeyRows(db, [connectorId]);
  if (!row) return undefined;
  try {
    return envelope.openString(row.sealed, siteKeyContext(connectorId, row.url));
  } catch {
    return undefined;
  }
}

export type SetSiteKeyOutcome =
  | { readonly ok: true; readonly replaced: boolean }
  | { readonly ok: false; readonly failure: "not_found" | "not_site_key" };

/** Sets or replaces the key of a live connector in `site` mode. */
export async function setSiteKey(
  db: KobeDb,
  envelope: Envelope,
  connectorId: string,
  apiKey: string,
  userId: string,
): Promise<SetSiteKeyOutcome> {
  return db.transaction(async (tx): Promise<SetSiteKeyOutcome> => {
    const [connector] = await tx
      .select({
        name: connectors.name,
        url: connectors.url,
        source: connectors.credentialSource,
        authKind: connectors.authKind,
      })
      .from(connectors)
      .where(and(eq(connectors.id, connectorId), isNull(connectors.deletedAt)))
      .for("update");
    if (!connector) return { ok: false, failure: "not_found" };
    if (connector.source !== "site" || connector.authKind !== "api_key") {
      return { ok: false, failure: "not_site_key" };
    }
    // Sealed for the URL read under the row lock, so a concurrent URL edit cannot be missed.
    const sealed = envelope.seal(apiKey, siteKeyContext(connectorId, connector.url));
    const values = {
      connectorId,
      sealed,
      keyId: Envelope.keyIdOf(sealed),
      urlSha256: urlSha256(connector.url),
      hint: maskHint(apiKey),
      updatedBy: userId,
    };
    const [existing] = await tx
      .select({ id: connectorSiteKeys.connectorId })
      .from(connectorSiteKeys)
      .where(eq(connectorSiteKeys.connectorId, connectorId));
    await tx
      .insert(connectorSiteKeys)
      .values(values)
      .onConflictDoUpdate({
        target: connectorSiteKeys.connectorId,
        set: {
          sealed: values.sealed,
          keyId: values.keyId,
          urlSha256: values.urlSha256,
          hint: values.hint,
          updatedBy: userId,
          updatedAt: sql`now()`,
        },
      });
    const replaced = existing !== undefined;
    await recordAudit(tx, {
      action: "mcp.connector.site_key_set",
      target: { connectorId, name: connector.name, replaced },
    });
    return { ok: true, replaced };
  });
}

export type SiteKeyRemoval = "removed" | "url_changed" | "mode_changed" | "connector_removed";

/** Deletes the key inside the caller's transaction (audited); false when there was none. */
export async function dropSiteKey(
  tx: KobeTx,
  connector: { readonly id: string; readonly name: string },
  reason: SiteKeyRemoval,
): Promise<boolean> {
  const removed = await tx
    .delete(connectorSiteKeys)
    .where(eq(connectorSiteKeys.connectorId, connector.id))
    .returning({ id: connectorSiteKeys.connectorId });
  if (removed.length === 0) return false;
  await recordAudit(tx, {
    action: "mcp.connector.site_key_removed",
    target: { connectorId: connector.id, name: connector.name, reason },
  });
  return true;
}

/** An admin removes the key; undefined when the connector is unknown, false when it had none. */
export function removeSiteKey(db: KobeDb, connectorId: string): Promise<boolean | undefined> {
  return db.transaction(async (tx) => {
    const [connector] = await tx
      .select({ name: connectors.name })
      .from(connectors)
      .where(and(eq(connectors.id, connectorId), isNull(connectors.deletedAt)))
      .for("update");
    if (!connector) return undefined;
    return dropSiteKey(tx, { id: connectorId, name: connector.name }, "removed");
  });
}

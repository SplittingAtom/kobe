import {
  and,
  connectorGrants,
  connectors,
  eq,
  sql,
  teamConnectors,
  withTeam,
  Envelope,
  type KobeDb,
} from "@kobe/db";
import { z } from "zod";
import { recordAudit } from "../audit/record.js";

/**
 * Per-user API-key grants (KOBE-108, D27: no shared team credentials). A user stores their own key
 * for an `api_key` connector their team enabled. The key is sealed with the install envelope
 * (KOBE-107, bound to team + user + connector) before it reaches Postgres, is never returned by
 * any API (callers get {@link GrantSummary}: a masked hint and timestamps), and is decrypted only
 * by {@link revealApiKey}, which the internal API hands to the MCP proxy for the run's own user.
 * Neither the key nor its hint is audited or logged.
 */
export const API_KEY_MAX = 2048;
export const API_KEY_MIN = 8;
/** Visible ASCII only: the key becomes an HTTP header value, so no whitespace or control bytes. */
export const apiKeySchema = z
  .string()
  .min(API_KEY_MIN)
  .max(API_KEY_MAX)
  .regex(/^[\x21-\x7e]+$/);

export const putGrantSchema = z.strictObject({ api_key: apiKeySchema });

export interface GrantSummary {
  readonly connectorId: string;
  /** Masked: never more than the last four characters, and none for a short key. */
  readonly hint: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type PutOutcome =
  | { readonly ok: true; readonly replaced: boolean; readonly grant: GrantSummary }
  | { readonly ok: false; readonly failure: "not_available" | "not_api_key" };

/** Envelope binding: a sealed key opens only for this team, user and connector. */
export function grantContext(teamId: string, userId: string, connectorId: string) {
  return { teamId, kind: "connector_grant", recordId: `${userId}:${connectorId}` } as const;
}

/** Last four characters of a long key; nothing of a short one. */
export function maskHint(apiKey: string): string {
  return apiKey.length >= 16 ? `••••${apiKey.slice(-4)}` : "••••";
}

const summaryColumns = {
  connectorId: connectorGrants.connectorId,
  hint: connectorGrants.hint,
  createdAt: connectorGrants.createdAt,
  updatedAt: connectorGrants.updatedAt,
};

/** The caller's own grants (masked). */
export function listGrants(db: KobeDb, teamId: string, userId: string): Promise<GrantSummary[]> {
  return withTeam(db, teamId, (tx) =>
    tx
      .select(summaryColumns)
      .from(connectorGrants)
      .where(and(eq(connectorGrants.teamId, teamId), eq(connectorGrants.userId, userId))),
  );
}

interface Subject {
  readonly teamId: string;
  readonly userId: string;
  readonly connectorId: string;
}

/** The connector, if the team enabled it and it is active. */
async function enabledConnector(tx: Parameters<Parameters<typeof withTeam>[2]>[0], s: Subject) {
  const [row] = await tx
    .select({ name: connectors.name, authKind: connectors.authKind, status: connectors.status })
    .from(teamConnectors)
    .innerJoin(connectors, eq(connectors.id, teamConnectors.connectorId))
    .where(and(eq(teamConnectors.teamId, s.teamId), eq(teamConnectors.connectorId, s.connectorId)));
  return row && row.status === "active" ? row : undefined;
}

/** Adds or replaces the caller's key for a connector. */
export async function putGrant(
  db: KobeDb,
  envelope: Envelope,
  subject: Subject,
  apiKey: string,
): Promise<PutOutcome> {
  const sealed = envelope.seal(
    apiKey,
    grantContext(subject.teamId, subject.userId, subject.connectorId),
  );
  const values = {
    teamId: subject.teamId,
    userId: subject.userId,
    connectorId: subject.connectorId,
    kind: "api_key" as const,
    sealed,
    keyId: Envelope.keyIdOf(sealed),
    hint: maskHint(apiKey),
  };
  return withTeam(db, subject.teamId, async (tx): Promise<PutOutcome> => {
    const connector = await enabledConnector(tx, subject);
    if (!connector) return { ok: false, failure: "not_available" };
    if (connector.authKind !== "api_key") return { ok: false, failure: "not_api_key" };
    const [existing] = await tx
      .select({ connectorId: connectorGrants.connectorId })
      .from(connectorGrants)
      .where(
        and(
          eq(connectorGrants.teamId, subject.teamId),
          eq(connectorGrants.userId, subject.userId),
          eq(connectorGrants.connectorId, subject.connectorId),
        ),
      )
      .for("update");
    const [grant] = await tx
      .insert(connectorGrants)
      .values(values)
      .onConflictDoUpdate({
        target: [connectorGrants.teamId, connectorGrants.userId, connectorGrants.connectorId],
        set: {
          sealed: values.sealed,
          keyId: values.keyId,
          hint: values.hint,
          updatedAt: sql`now()`,
        },
      })
      .returning(summaryColumns);
    if (!grant) throw new Error("grant upsert returned nothing");
    const replaced = existing !== undefined;
    await recordAudit(tx, {
      action: replaced ? "mcp.grant.replaced" : "mcp.grant.added",
      teamId: subject.teamId,
      target: { connectorId: subject.connectorId, name: connector.name },
    });
    return { ok: true, replaced, grant };
  });
}

/** Removes the caller's key; false when there was none. */
export function removeGrant(db: KobeDb, subject: Subject): Promise<boolean> {
  return withTeam(db, subject.teamId, async (tx) => {
    const removed = await tx
      .delete(connectorGrants)
      .where(
        and(
          eq(connectorGrants.teamId, subject.teamId),
          eq(connectorGrants.userId, subject.userId),
          eq(connectorGrants.connectorId, subject.connectorId),
        ),
      )
      .returning({ connectorId: connectorGrants.connectorId });
    if (removed.length === 0) return false;
    const [connector] = await tx
      .select({ name: connectors.name })
      .from(connectors)
      .where(eq(connectors.id, subject.connectorId));
    await recordAudit(tx, {
      action: "mcp.grant.removed",
      teamId: subject.teamId,
      target: { connectorId: subject.connectorId, name: connector?.name ?? "unknown" },
    });
    return true;
  });
}

export type RevealOutcome =
  | { readonly ok: true; readonly apiKey: string }
  | { readonly ok: false; readonly failure: "not_available" | "not_connected" | "unavailable" };

/**
 * Decrypts the key of (team, user, connector) for the MCP proxy. Only the internal API calls this,
 * with `userId` taken from the verified sandbox token, never from the request. Fails closed: an
 * unreadable ciphertext (wrong key, tampering) is `unavailable`, with nothing about why.
 */
export async function revealApiKey(
  db: KobeDb,
  envelope: Envelope,
  subject: Subject,
): Promise<RevealOutcome> {
  const row = await withTeam(db, subject.teamId, async (tx) => {
    const connector = await enabledConnector(tx, subject);
    if (!connector || connector.authKind !== "api_key") return "not_available" as const;
    const [grant] = await tx
      .select({ sealed: connectorGrants.sealed })
      .from(connectorGrants)
      .where(
        and(
          eq(connectorGrants.teamId, subject.teamId),
          eq(connectorGrants.userId, subject.userId),
          eq(connectorGrants.connectorId, subject.connectorId),
        ),
      );
    return grant ?? ("not_connected" as const);
  });
  if (typeof row === "string") return { ok: false, failure: row };
  try {
    const apiKey = envelope.openString(
      row.sealed,
      grantContext(subject.teamId, subject.userId, subject.connectorId),
    );
    return { ok: true, apiKey };
  } catch {
    return { ok: false, failure: "unavailable" };
  }
}

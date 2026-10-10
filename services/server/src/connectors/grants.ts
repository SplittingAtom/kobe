import {
  and,
  connectorGrants,
  connectors,
  eq,
  sql,
  teamConnectors,
  withTeam,
  Envelope,
  listMemberships,
  SYSTEM_ACTOR,
  teamMembers,
  teams,
  TEAM_ID_SETTING,
  users,
  type ConnectorGrantKind,
  type KobeTx,
  type KobeDb,
} from "@kobe/db";
import { z } from "zod";
import { logger } from "../logger.js";
import { recordAudit } from "../audit/record.js";
import { parseOauthBundle, serializeOauthBundle, type OauthBundle } from "./oauth/bundle.js";
import { OauthError, type OauthIo } from "./oauth/http.js";
import { refreshAccessToken } from "./oauth/refresh.js";
import { sameUrl } from "./oauth/discovery.js";

/**
 * Per-user API-key grants (KOBE-108, D27: no shared team credentials; OAuth tokens KOBE-109). A user stores their own key
 * for an `api_key` connector their team enabled. The key is sealed with the install envelope
 * (KOBE-107, bound to team + user + connector) before it reaches Postgres, is never returned by
 * any API (callers get {@link GrantSummary}: a masked hint and timestamps), and is decrypted only
 * by {@link revealCredential}, which the internal API hands to the MCP proxy for the run's own user.
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
  readonly kind: ConnectorGrantKind;
  /** OAuth access-token expiry; null for API keys. */
  readonly expiresAt: Date | null;
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
  kind: connectorGrants.kind,
  expiresAt: connectorGrants.expiresAt,
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

export interface Subject {
  readonly teamId: string;
  readonly userId: string;
  readonly connectorId: string;
}

/** The connector, if the team enabled it and it is active. */
export async function enabledConnector(
  tx: Parameters<Parameters<typeof withTeam>[2]>[0],
  s: Subject,
) {
  const [row] = await tx
    .select({
      name: connectors.name,
      url: connectors.url,
      authKind: connectors.authKind,
      status: connectors.status,
    })
    .from(teamConnectors)
    .innerJoin(connectors, eq(connectors.id, teamConnectors.connectorId))
    .where(and(eq(teamConnectors.teamId, s.teamId), eq(teamConnectors.connectorId, s.connectorId)));
  return row && row.status === "active" ? row : undefined;
}

/** What a stored grant is made of, before sealing. */
export interface GrantMaterial {
  readonly kind: ConnectorGrantKind;
  /** The secret text to seal: the API key, or the OAuth token bundle as JSON. */
  readonly plaintext: string;
  readonly hint: string;
  readonly expiresAt?: Date;
}

/**
 * Seals and upserts a grant for a connector the team enabled whose `auth_kind` matches the
 * material's kind. Shared by API keys (KOBE-108) and OAuth tokens (KOBE-109).
 */
export async function storeGrant(
  db: KobeDb,
  envelope: Envelope,
  subject: Subject,
  material: GrantMaterial,
): Promise<PutOutcome> {
  const sealed = envelope.seal(
    material.plaintext,
    grantContext(subject.teamId, subject.userId, subject.connectorId),
  );
  const values = {
    teamId: subject.teamId,
    userId: subject.userId,
    connectorId: subject.connectorId,
    kind: material.kind,
    sealed,
    keyId: Envelope.keyIdOf(sealed),
    hint: material.hint,
    expiresAt: material.expiresAt ?? null,
  };
  return withTeam(db, subject.teamId, async (tx): Promise<PutOutcome> => {
    const connector = await enabledConnector(tx, subject);
    if (!connector) return { ok: false, failure: "not_available" };
    if (connector.authKind !== material.kind) return { ok: false, failure: "not_api_key" };
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
          kind: values.kind,
          sealed: values.sealed,
          keyId: values.keyId,
          hint: values.hint,
          expiresAt: values.expiresAt,
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

/** Adds or replaces the caller's key for a connector. */
export function putGrant(
  db: KobeDb,
  envelope: Envelope,
  subject: Subject,
  apiKey: string,
): Promise<PutOutcome> {
  return storeGrant(db, envelope, subject, {
    kind: "api_key",
    plaintext: apiKey,
    hint: maskHint(apiKey),
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

async function auditRefusal(
  db: KobeDb,
  subject: Subject,
  name: string,
  reason: "resource_mismatch" | "user_inactive",
): Promise<void> {
  try {
    await withTeam(db, subject.teamId, (tx) =>
      recordAudit(tx, {
        action: "mcp.grant.refused",
        actor: SYSTEM_ACTOR,
        teamId: subject.teamId,
        target: { connectorId: subject.connectorId, name, reason },
      }),
    );
  } catch {
    // The refusal stands even if the audit write fails; the caller gets "unavailable".
  }
}

/** A credential decrypted for the MCP proxy. */
export type RevealedCredential =
  | { readonly kind: "api_key"; readonly apiKey: string }
  | { readonly kind: "oauth"; readonly accessToken: string };

export type RevealOutcome =
  | { readonly ok: true; readonly credential: RevealedCredential }
  | { readonly ok: false; readonly failure: "not_available" | "not_connected" | "unavailable" };

/** An access token is refreshed this long before it expires, so a call never races the expiry. */
export const REFRESH_SKEW_MS = 60_000;

interface GrantRow {
  readonly sealed: string;
  readonly kind: ConnectorGrantKind;
  readonly expiresAt: Date | null;
  readonly connectorUrl: string;
  readonly connectorName: string;
}
type GrantLookup = GrantRow | "not_available" | "not_connected" | "user_inactive";

/**
 * The grant, if the whole chain is live right now: the connector enabled for the team and active,
 * the user not deactivated (KOBE-13) and still a member of the team, the grant present and of the
 * connector's kind. Checked on every reveal, so a deactivation, removal, suspension or revoke
 * needs no sweep to take effect. `lock` takes the grant row `FOR UPDATE`.
 */
async function loadGrant(tx: KobeTx, s: Subject, lock: boolean): Promise<GrantLookup> {
  const connector = await enabledConnector(tx, s);
  if (!connector || connector.authKind === "none") return "not_available";
  const [account] = await tx
    .select({ deactivatedAt: users.deactivatedAt })
    .from(users)
    .where(eq(users.id, s.userId));
  const [member] = await tx
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, s.teamId), eq(teamMembers.userId, s.userId)));
  if (!account || account.deactivatedAt !== null || !member) return "user_inactive";
  const query = tx
    .select({
      sealed: connectorGrants.sealed,
      kind: connectorGrants.kind,
      expiresAt: connectorGrants.expiresAt,
    })
    .from(connectorGrants)
    .where(
      and(
        eq(connectorGrants.teamId, s.teamId),
        eq(connectorGrants.userId, s.userId),
        eq(connectorGrants.connectorId, s.connectorId),
      ),
    );
  const [grant] = await (lock ? query.for("update") : query);
  return grant && grant.kind === connector.authKind
    ? { ...grant, connectorUrl: connector.url, connectorName: connector.name }
    : "not_connected";
}

const needsRefresh = (row: GrantRow, now: Date): boolean =>
  row.kind === "oauth" &&
  row.expiresAt !== null &&
  row.expiresAt.getTime() - REFRESH_SKEW_MS <= now.getTime();
const isExpired = (row: GrantRow, now: Date): boolean =>
  row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();

/** Opens the sealed material; the token was issued for one server and must not go elsewhere. */
async function openRow(
  db: KobeDb,
  envelope: Envelope,
  subject: Subject,
  row: GrantRow,
): Promise<RevealOutcome> {
  const plaintext = envelope.openString(
    row.sealed,
    grantContext(subject.teamId, subject.userId, subject.connectorId),
  );
  if (row.kind !== "oauth") return { ok: true, credential: { kind: "api_key", apiKey: plaintext } };
  const bundle = parseOauthBundle(plaintext);
  if (!sameUrl(bundle.resource, row.connectorUrl)) {
    await auditRefusal(db, subject, row.connectorName, "resource_mismatch");
    return { ok: false, failure: "unavailable" };
  }
  return { ok: true, credential: { kind: "oauth", accessToken: bundle.access_token } };
}

/**
 * Decrypts the grant of (team, user, connector) for the MCP proxy. Only the internal API calls
 * this, with `userId` taken from the verified sandbox token, never from the request. Fails
 * closed: an unreadable ciphertext (wrong key, tampering) is `unavailable`, with nothing about
 * why; a grant whose kind no longer matches the connector's auth kind is `not_connected`. An
 * OAuth access token at or near expiry is refreshed first ({@link refreshAndReveal}); without
 * `refresh` (no OAuth client wired) it is `unavailable`.
 */
export async function revealCredential(
  db: KobeDb,
  envelope: Envelope,
  subject: Subject,
  now: Date = new Date(),
  refresh?: OauthIo,
): Promise<RevealOutcome> {
  const row = await withTeam(db, subject.teamId, (tx) => loadGrant(tx, subject, false));
  const refused = await refusal(db, subject, row);
  if (refused) return refused;
  const grant = row as GrantRow;
  try {
    if (needsRefresh(grant, now)) {
      if (!refresh)
        return isExpired(grant, now) ? UNAVAILABLE : await openRow(db, envelope, subject, grant);
      return await refreshAndReveal(db, envelope, subject, now, refresh);
    }
    return await openRow(db, envelope, subject, grant);
  } catch {
    return UNAVAILABLE;
  }
}

function bundleWithoutVersion(bundle: OauthBundle): Omit<OauthBundle, "v"> {
  const { v: _v, ...rest } = bundle;
  return rest;
}

const UNAVAILABLE: RevealOutcome = { ok: false, failure: "unavailable" };

async function refusal(
  db: KobeDb,
  subject: Subject,
  row: GrantLookup,
): Promise<RevealOutcome | undefined> {
  if (typeof row !== "string") return undefined;
  if (row === "user_inactive") {
    await auditRefusal(db, subject, "connector", "user_inactive");
    return { ok: false, failure: "not_available" };
  }
  return { ok: false, failure: row };
}

/**
 * Refreshes an OAuth grant under a row lock. The lock is what keeps replicas from both spending
 * a rotating refresh token: the second caller blocks on `FOR UPDATE`, then re-reads the row,
 * finds it fresh and serves what the first stored. A revoke (a DELETE of the row) queues behind
 * the same lock and wins afterwards, so no token is stored after it. The authorization server
 * is called with the lock held (10 s cap). A refresh the server rejects for good drops the grant
 * and audits it (the user reconnects); a transient failure keeps it and serves the old token
 * only if it has not actually expired.
 */
async function refreshAndReveal(
  db: KobeDb,
  envelope: Envelope,
  subject: Subject,
  now: Date,
  io: OauthIo,
): Promise<RevealOutcome> {
  const result = await withTeam(
    db,
    subject.teamId,
    async (tx): Promise<RevealOutcome | GrantRow> => {
      const row = await loadGrant(tx, subject, true);
      if (typeof row === "string") return (await refusal(db, subject, row)) as RevealOutcome;
      if (!needsRefresh(row, now)) return row;
      const bundle = parseOauthBundle(
        envelope.openString(
          row.sealed,
          grantContext(subject.teamId, subject.userId, subject.connectorId),
        ),
      );
      if (!sameUrl(bundle.resource, row.connectorUrl)) return row;
      const failed = async (reason: "rejected" | "no_refresh_token"): Promise<RevealOutcome> => {
        await tx
          .delete(connectorGrants)
          .where(
            and(
              eq(connectorGrants.teamId, subject.teamId),
              eq(connectorGrants.userId, subject.userId),
              eq(connectorGrants.connectorId, subject.connectorId),
            ),
          );
        await recordAudit(tx, {
          action: "mcp.grant.refresh_failed",
          actor: SYSTEM_ACTOR,
          teamId: subject.teamId,
          target: { connectorId: subject.connectorId, name: row.connectorName, reason },
        });
        return { ok: false, failure: "not_connected" };
      };
      if (bundle.refresh_token === undefined) {
        return isExpired(row, now) ? failed("no_refresh_token") : row;
      }
      try {
        const tokens = await refreshAccessToken(io, bundle, now);
        const next = serializeOauthBundle({
          ...bundleWithoutVersion(bundle),
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken ?? bundle.refresh_token,
          ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
        });
        const sealed = envelope.seal(
          next,
          grantContext(subject.teamId, subject.userId, subject.connectorId),
        );
        const [saved] = await tx
          .update(connectorGrants)
          .set({
            sealed,
            keyId: Envelope.keyIdOf(sealed),
            expiresAt: tokens.expiresAt ?? null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(connectorGrants.teamId, subject.teamId),
              eq(connectorGrants.userId, subject.userId),
              eq(connectorGrants.connectorId, subject.connectorId),
            ),
          )
          .returning({ id: connectorGrants.connectorId });
        if (!saved) throw new Error("grant vanished under lock");
        return { ok: true, credential: { kind: "oauth", accessToken: tokens.accessToken } };
      } catch (error) {
        if (error instanceof OauthError && error.code === "refresh_rejected")
          return failed("rejected");
        logger.warn(
          {
            connectorId: subject.connectorId,
            code: error instanceof OauthError ? error.code : "error",
          },
          "oauth grant refresh failed; keeping the grant",
        );
        return isExpired(row, now) ? UNAVAILABLE : row;
      }
    },
  );
  if ("ok" in result) return result;
  return openRow(db, envelope, subject, result);
}

/**
 * The install admin's OWN key for a connector, for a pinning probe (pins are install-wide trust,
 * so only an admin's action may probe with a grant, and only with that admin's grant). Looks
 * through the admin's teams; never another user's key. Undefined when they have none.
 */
export async function adminProbeKey(
  db: KobeDb,
  envelope: Envelope | undefined,
  adminUserId: string,
  connectorId: string,
): Promise<string | undefined> {
  if (!envelope) return undefined;
  for (const team of await listMemberships(db, adminUserId)) {
    const found = await revealCredential(db, envelope, {
      teamId: team.teamId,
      userId: adminUserId,
      connectorId,
    });
    if (found.ok && found.credential.kind === "api_key") return found.credential.apiKey;
  }
  return undefined;
}

/**
 * Drops every user's grants for a connector, in every team, inside the caller's transaction. Used
 * when the connector's URL changes: a credential issued for one server must never reach another,
 * and users reconnect or re-enter their key. Audits one `mcp.grant.removed` per grant.
 */
export async function dropConnectorGrants(
  tx: KobeTx,
  connectorId: string,
  name: string,
): Promise<number> {
  const all = await tx.select({ id: teams.id }).from(teams);
  let dropped = 0;
  for (const team of all) {
    await tx.execute(sql`SELECT set_config(${TEAM_ID_SETTING}, ${team.id}, true)`);
    const removed = await tx
      .delete(connectorGrants)
      .where(and(eq(connectorGrants.teamId, team.id), eq(connectorGrants.connectorId, connectorId)))
      .returning({ userId: connectorGrants.userId });
    for (const _ of removed) {
      await recordAudit(tx, {
        action: "mcp.grant.removed",
        teamId: team.id,
        target: { connectorId, name },
      });
    }
    dropped += removed.length;
  }
  await tx.execute(sql`SELECT set_config(${TEAM_ID_SETTING}, '', true)`);
  return dropped;
}

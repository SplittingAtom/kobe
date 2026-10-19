import {
  SYSTEM_ACTOR,
  and,
  connectors,
  eq,
  isNull,
  siteRoles,
  sql,
  users,
  type Envelope,
  type KobeDb,
} from "@kobe/db";
import { recordAuditAfter } from "../audit/record.js";
import { adminProbeKey } from "./grants.js";

/**
 * Which credential probes a connector's `tools/list` (KOBE-431, decision (a) of 2026-10-19; the
 * site-wide key of KOBE-303 first). Pins are site-wide trust, so a probe uses, in this order:
 *
 * 1. the connector's site-wide API key, when it has one (KOBE-303);
 * 2. the own API key of one site admin: for the periodic refresh the admin who last pinned or
 *    re-approved the connector (`connectors.pinned_by`), for an admin's own action that admin;
 *    only while they are active and still a site admin;
 * 3. nothing: a server that wants a credential answers `auth_required`.
 *
 * Never a member's key. One function for every probe (registration, pin, refresh, KOBE-430's
 * Re-probe button), so the rule lives in one place. The value is returned to the caller only, for
 * the one probe; {@link auditProbeCredential} records the choice without it.
 */
export type ProbeCredentialSource = "site_key" | "admin_key" | "none";

export interface ProbeCredential {
  readonly source: ProbeCredentialSource;
  /** The admin whose key it is (`admin_key`). */
  readonly adminId?: string;
  /** For the probe only: never stored, logged or audited. */
  readonly apiKey?: string;
}

const NONE: ProbeCredential = { source: "none" };

/** Active (not deactivated) and holding a site role, so trusted with site-wide pins. */
async function isActiveSiteAdmin(db: KobeDb, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(siteRoles, eq(siteRoles.userId, users.id))
    .where(and(eq(users.id, userId), isNull(users.deactivatedAt)));
  return row !== undefined;
}

export async function chooseProbeCredential(
  db: KobeDb,
  envelope: Envelope | undefined,
  connectorId: string,
  /** The admin acting now, or `"pinned_by"` for the admin who last pinned or approved it. */
  admin: string | "pinned_by",
): Promise<ProbeCredential> {
  const [row] = await db
    .select({ authKind: connectors.authKind, pinnedBy: connectors.pinnedBy })
    .from(connectors)
    .where(eq(connectors.id, connectorId));
  if (!row || row.authKind !== "api_key" || !envelope) return NONE;
  const adminId = admin === "pinned_by" ? row.pinnedBy : admin;
  if (adminId === null || !(await isActiveSiteAdmin(db, adminId))) return NONE;
  const apiKey = await adminProbeKey(db, envelope, adminId, connectorId);
  return apiKey === undefined ? NONE : { source: "admin_key", adminId, apiKey };
}

export type ProbePurpose = "pin" | "refresh";

const auditTarget = (
  connectorId: string,
  name: string,
  purpose: ProbePurpose,
  choice: ProbeCredential,
) => ({
  connectorId,
  name,
  purpose,
  credential: choice.source,
  ...(choice.adminId === undefined ? {} : { adminId: choice.adminId }),
});

/** The refresh's last recorded choice, to audit only a change. */
async function lastRefreshChoice(
  db: KobeDb,
  connectorId: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await db.execute<{ target: Record<string, unknown> }>(sql`
    SELECT target FROM audit_log
     WHERE action = 'mcp.connector.probe_credential'
       AND target->>'connectorId' = ${connectorId} AND target->>'purpose' = 'refresh'
     ORDER BY seq DESC LIMIT 1`);
  return rows.rows[0]?.target;
}

/**
 * Records the choice, never the value: every pin (an admin's action, as that admin), and the
 * refresh (system actor) only when its choice differs from the last one recorded.
 */
export async function auditProbeCredential(
  db: KobeDb,
  connector: { readonly id: string; readonly name: string },
  purpose: ProbePurpose,
  choice: ProbeCredential,
): Promise<void> {
  const target = auditTarget(connector.id, connector.name, purpose, choice);
  if (purpose === "refresh") {
    const last = await lastRefreshChoice(db, connector.id);
    if (
      last &&
      last.credential === target.credential &&
      last.adminId === (target as { adminId?: string }).adminId
    ) {
      return;
    }
  }
  await recordAuditAfter(db, {
    action: "mcp.connector.probe_credential",
    ...(purpose === "refresh" ? { actor: SYSTEM_ACTOR } : {}),
    target,
  });
}

/**
 * The credential of a pin an admin asked for (registration, a new URL, the pin endpoint, KOBE-430's
 * Re-probe): chosen with that admin as the fallback, and audited as theirs.
 */
export function adminPinCredential(
  db: KobeDb,
  envelope: Envelope | undefined,
  adminId: string,
): (connector: { readonly id: string; readonly name: string }) => Promise<string | undefined> {
  return async (connector) => {
    const choice = await chooseProbeCredential(db, envelope, connector.id, adminId);
    await auditProbeCredential(db, connector, "pin", choice);
    return choice.apiKey;
  };
}

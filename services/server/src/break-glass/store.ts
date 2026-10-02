import {
  SYSTEM_ACTOR,
  and,
  breakGlassGrants,
  desc,
  eq,
  getMembership,
  inArray,
  installRoles,
  isNull,
  ne,
  or,
  sql,
  teams,
  users,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import type { RequestGrantBody } from "./schemas.js";

/**
 * Break-glass grants (spec D10, KOBE-16): request, two-person approval, denial, revocation and
 * expiry. Every change runs in one transaction with the grant row locked and its audit event as
 * the last write. The `break_glass_grants_guard` trigger re-checks the same rules in Postgres
 * (roles, two-person rule, window, transitions); the checks here exist to answer with clear errors.
 * Reading team content is not here: see `readWithBreakGlass()` in @kobe/db.
 */

export type GrantRow = typeof breakGlassGrants.$inferSelect;
export type EffectiveStatus = "pending" | "active" | "denied" | "revoked" | "expired";
export type GrantScope = "team" | "user" | "thread";

export type GrantError =
  | "team_not_found"
  | "subject_not_member"
  | "subject_is_requester"
  | "grant_not_found"
  | "not_pending"
  | "not_open"
  | "request_lapsed"
  | "self_approval_forbidden"
  | "subject_cannot_approve"
  | "subject_cannot_decide"
  | "cannot_deny_own";

export type GrantResult = { ok: true; grant: GrantRow } | { ok: false; error: GrantError };

/** Lock wait for a grant row: approvals and revocations are short. */
const LOCK_TIMEOUT = "5s";

export function scopeOf(grant: Pick<GrantRow, "userId" | "threadId">): GrantScope {
  if (grant.threadId !== null) return "thread";
  return grant.userId !== null ? "user" : "team";
}

/** The status people see: approved grants are `active` until their window ends. */
export function effectiveStatus(grant: GrantRow, now = new Date()): EffectiveStatus {
  if (grant.status === "approved") {
    return grant.expiresAt !== null && grant.expiresAt > now ? "active" : "expired";
  }
  if (grant.status === "pending" && grant.requestExpiresAt <= now) return "expired";
  return grant.status;
}

/**
 * The audit target describing a grant's scope (ids only, never the reason). Team-scope events show
 * in the team's audit view, so a legal hold leaves out the subject and thread (the grant row,
 * resolved by `grantId` in the install console, keeps them).
 */
function scopeTarget(grant: GrantRow) {
  const shown = !grant.legalHold;
  return {
    grantId: grant.id,
    scope: scopeOf(grant),
    ...(grant.userId && shown ? { subjectUserId: grant.userId } : {}),
    ...(grant.threadId && shown ? { threadId: grant.threadId } : {}),
    legalHold: grant.legalHold,
  };
}

/** Active install admins (Owner and Admins), optionally without one user. */
export async function activeInstallAdmins(
  db: KobeDb | KobeTx,
  except?: string,
): Promise<{ id: string; name: string; email: string }[]> {
  return db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(installRoles)
    .innerJoin(users, eq(users.id, installRoles.userId))
    .where(and(isNull(users.deactivatedAt), except ? ne(users.id, except) : undefined));
}

/** Whether `adminId` is the only active install admin, so D10 lets them approve their own request. */
export async function isSoleInstallAdmin(db: KobeDb | KobeTx, adminId: string): Promise<boolean> {
  // Deactivated admins count too: deactivating the other admin must not unlock self-approval.
  const [other] = await db
    .select({ userId: installRoles.userId })
    .from(installRoles)
    .where(ne(installRoles.userId, adminId))
    .limit(1);
  return other === undefined;
}

async function lockGrant(tx: KobeTx, id: string): Promise<GrantRow | undefined> {
  await tx.execute(sql`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
  const [row] = await tx
    .select()
    .from(breakGlassGrants)
    .where(eq(breakGlassGrants.id, id))
    .for("update");
  return row;
}

export async function requestGrant(
  db: KobeDb,
  adminId: string,
  body: RequestGrantBody,
): Promise<GrantResult> {
  const [team] = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, body.teamId));
  if (!team) return { ok: false, error: "team_not_found" };
  if (body.userId !== undefined) {
    if (body.userId === adminId) return { ok: false, error: "subject_is_requester" };
    // Rosters are team metadata install admins may read (KOBE-14), not content.
    if ((await getMembership(db, body.teamId, body.userId)) === null) {
      return { ok: false, error: "subject_not_member" };
    }
  }
  const grant = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(breakGlassGrants)
      .values({
        teamId: body.teamId,
        adminId,
        userId: body.userId ?? null,
        threadId: body.threadId ?? null,
        reason: body.reason,
        legalHold: body.legalHold,
        durationMinutes: body.durationMinutes,
      })
      .returning();
    if (!row) throw new Error("break-glass insert returned no row");
    await recordAudit(tx, {
      action: "governance.break_glass.requested",
      teamId: row.teamId,
      target: { ...scopeTarget(row), durationMinutes: row.durationMinutes },
    });
    return row;
  });
  return { ok: true, grant };
}

/**
 * Approves a pending request as `approverId` (D10): a second install admin, or the requester only
 * when no other active install admin exists (flagged `selfApproved`).
 */
export async function approveGrant(
  db: KobeDb,
  approverId: string,
  grantId: string,
): Promise<GrantResult> {
  return db.transaction(async (tx): Promise<GrantResult> => {
    const current = await lockGrant(tx, grantId);
    if (!current) return { ok: false, error: "grant_not_found" };
    if (current.status !== "pending") return { ok: false, error: "not_pending" };
    if (current.requestExpiresAt <= new Date()) return { ok: false, error: "request_lapsed" };
    if (current.userId === approverId) return { ok: false, error: "subject_cannot_approve" };
    if (current.adminId === approverId && !(await isSoleInstallAdmin(tx, approverId))) {
      return { ok: false, error: "self_approval_forbidden" };
    }
    const [row] = await tx
      .update(breakGlassGrants)
      .set({ status: "approved", approverId })
      .where(eq(breakGlassGrants.id, grantId))
      .returning();
    if (!row?.expiresAt) throw new Error("break-glass approval returned no window");
    await recordAudit(tx, {
      action: "governance.break_glass.approved",
      teamId: row.teamId,
      target: {
        ...scopeTarget(row),
        expiresAt: row.expiresAt.toISOString(),
        selfApproved: row.selfApproved,
      },
    });
    return { ok: true, grant: row };
  });
}

/** Denies a pending request; the requester withdraws instead (revoke). */
export async function denyGrant(db: KobeDb, by: string, grantId: string): Promise<GrantResult> {
  return db.transaction(async (tx): Promise<GrantResult> => {
    const current = await lockGrant(tx, grantId);
    if (!current) return { ok: false, error: "grant_not_found" };
    if (current.status !== "pending") return { ok: false, error: "not_pending" };
    if (current.adminId === by) return { ok: false, error: "cannot_deny_own" };
    if (current.userId === by) return { ok: false, error: "subject_cannot_decide" };
    const [row] = await tx
      .update(breakGlassGrants)
      .set({ status: "denied", decidedBy: by })
      .where(eq(breakGlassGrants.id, grantId))
      .returning();
    if (!row) throw new Error("break-glass denial returned no row");
    await recordAudit(tx, {
      action: "governance.break_glass.denied",
      teamId: row.teamId,
      target: { grantId: row.id },
    });
    return { ok: true, grant: row };
  });
}

/**
 * Ends a pending request (withdrawal) or an active grant (revocation) at once: the next read is
 * refused, and a read in flight finishes first (it holds the grant row in share mode).
 */
export async function revokeGrant(db: KobeDb, by: string, grantId: string): Promise<GrantResult> {
  return db.transaction(async (tx): Promise<GrantResult> => {
    const current = await lockGrant(tx, grantId);
    if (!current) return { ok: false, error: "grant_not_found" };
    if (current.userId === by) return { ok: false, error: "subject_cannot_decide" };
    const status = effectiveStatus(current);
    if (status !== "pending" && status !== "active") return { ok: false, error: "not_open" };
    const [row] = await tx
      .update(breakGlassGrants)
      .set({ status: "revoked", decidedBy: by })
      .where(eq(breakGlassGrants.id, grantId))
      .returning();
    if (!row) throw new Error("break-glass revocation returned no row");
    await recordAudit(tx, {
      action: "governance.break_glass.revoked",
      teamId: row.teamId,
      target: { grantId: row.id, wasActive: status === "active" },
    });
    return { ok: true, grant: row };
  });
}

/** Most this sweep expires per run; the next run continues. */
const SWEEP_BATCH = 100;

/**
 * Records the end of grants whose window is over and requests nobody decided in time (system
 * actor). Access never waits for this: reads check `expires_at` themselves. Safe on every replica
 * at once: rows are claimed with SKIP LOCKED and re-checked by the guard trigger.
 */
export async function expireDueGrants(
  db: KobeDb,
): Promise<{ grant: GrantRow; wasActive: boolean }[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: breakGlassGrants.id, status: breakGlassGrants.status })
      .from(breakGlassGrants)
      .where(
        or(
          and(eq(breakGlassGrants.status, "approved"), sql`${breakGlassGrants.expiresAt} <= now()`),
          and(
            eq(breakGlassGrants.status, "pending"),
            sql`${breakGlassGrants.requestExpiresAt} <= now()`,
          ),
        ),
      )
      .orderBy(breakGlassGrants.requestedAt)
      .limit(SWEEP_BATCH)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    const rows = await tx
      .update(breakGlassGrants)
      .set({ status: "expired" })
      .where(
        inArray(
          breakGlassGrants.id,
          due.map((d) => d.id),
        ),
      )
      .returning();
    const wasActive = new Map(due.map((d) => [d.id, d.status === "approved"]));
    const expired = rows.map((grant) => ({ grant, wasActive: wasActive.get(grant.id) ?? false }));
    // Audit rows last (they hold the chain lock until commit).
    for (const { grant, wasActive: active } of expired) {
      await recordAudit(tx, {
        action: "governance.break_glass.expired",
        actor: SYSTEM_ACTOR,
        teamId: grant.teamId,
        target: { grantId: grant.id, wasActive: active },
      });
    }
    return expired;
  });
}

type Person = { id: string; name: string; email: string };

export interface GrantDetail {
  readonly grant: GrantRow;
  readonly team: { id: string; slug: string; name: string };
  readonly requestedBy: Person;
  readonly approvedBy: Person | null;
  readonly decidedBy: Person | null;
  readonly subject: Person | null;
}

/** Joins each grant's people and team (two queries, whatever the page size). */
async function withDetails(db: KobeDb, rows: readonly GrantRow[]): Promise<GrantDetail[]> {
  if (rows.length === 0) return [];
  const userIds = [
    ...new Set(
      rows
        .flatMap((r) => [r.adminId, r.approverId, r.decidedBy, r.userId])
        .filter((v) => v !== null),
    ),
  ];
  const teamIds = [...new Set(rows.map((r) => r.teamId))];
  const [people, teamRows] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, userIds)),
    db
      .select({ id: teams.id, slug: teams.slug, name: teams.name })
      .from(teams)
      .where(inArray(teams.id, teamIds)),
  ]);
  const byId = new Map(people.map((p) => [p.id, p]));
  const teamById = new Map(teamRows.map((t) => [t.id, t]));
  const find = (id: string | null) => (id === null ? null : (byId.get(id) ?? null));
  return rows.map((grant) => {
    const team = teamById.get(grant.teamId);
    const requestedBy = byId.get(grant.adminId);
    if (!team || !requestedBy) throw new Error("break-glass grant references a missing row");
    return {
      grant,
      team,
      requestedBy,
      approvedBy: find(grant.approverId),
      decidedBy: find(grant.decidedBy),
      subject: find(grant.userId),
    };
  });
}

/**
 * Grants with their people and team, newest first (install view). A legal hold is invisible to
 * its subject, even when the subject is an install admin.
 */
export async function listGrants(
  db: KobeDb,
  viewerId: string,
  filter: { teamId?: string | undefined; limit?: number } = {},
): Promise<GrantDetail[]> {
  const rows = await db
    .select()
    .from(breakGlassGrants)
    .where(
      and(
        filter.teamId ? eq(breakGlassGrants.teamId, filter.teamId) : undefined,
        hiddenFrom(viewerId),
      ),
    )
    .orderBy(desc(breakGlassGrants.requestedAt), desc(breakGlassGrants.id))
    .limit(filter.limit ?? 200);
  return withDetails(db, rows);
}

/** Excludes legal-hold grants about `viewerId`. */
function hiddenFrom(viewerId: string) {
  return sql`NOT (${breakGlassGrants.legalHold} AND ${breakGlassGrants.userId} IS NOT DISTINCT FROM ${viewerId}::uuid)`;
}

/** One grant; with `viewerId`, a legal hold about the viewer is not found. */
export async function getGrant(
  db: KobeDb,
  id: string,
  viewerId?: string,
): Promise<GrantDetail | undefined> {
  const rows = await db
    .select()
    .from(breakGlassGrants)
    .where(and(eq(breakGlassGrants.id, id), viewerId ? hiddenFrom(viewerId) : undefined));
  return (await withDetails(db, rows))[0];
}

/** Grants of one team that were approved at some point (they gave access), newest first. */
export async function listTeamGrants(
  db: KobeDb,
  teamId: string,
  limit = 50,
): Promise<GrantDetail[]> {
  const rows = await db
    .select()
    .from(breakGlassGrants)
    .where(and(eq(breakGlassGrants.teamId, teamId), sql`${breakGlassGrants.startsAt} IS NOT NULL`))
    .orderBy(desc(breakGlassGrants.startsAt), desc(breakGlassGrants.id))
    .limit(limit);
  return withDetails(db, rows);
}

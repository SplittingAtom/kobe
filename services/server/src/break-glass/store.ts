import {
  AuditBusyError,
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
import { enqueueNotifications, type QueuedCounts } from "./outbox.js";
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
  | "cannot_deny_own"
  | "too_many_pending";

export type GrantResult =
  { ok: true; grant: GrantRow; queued: QueuedCounts } | { ok: false; error: GrantError };

/** Open (undecided) requests one install admin may have at a time. */
export const BREAK_GLASS_MAX_PENDING_PER_ADMIN = 3;

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
  return (await activeInstallAdmins(db, adminId)).length === 0;
}

async function lockGrant(
  tx: KobeTx,
  id: string,
  lockTimeout = LOCK_TIMEOUT,
): Promise<GrantRow | undefined> {
  await tx.execute(sql`SELECT set_config('lock_timeout', ${lockTimeout}, true)`);
  const [row] = await tx
    .select()
    .from(breakGlassGrants)
    .where(eq(breakGlassGrants.id, id))
    .for("update");
  return row;
}

/** A legal hold is invisible to its subject: deciding it answers like an unknown grant. */
function subjectError(grant: GrantRow, by: string, otherwise: GrantError): GrantError | null {
  if (grant.userId !== by) return null;
  return grant.legalHold ? "grant_not_found" : otherwise;
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
  return db.transaction(async (tx): Promise<GrantResult> => {
    // One admin's open requests are capped; the per-admin lock makes the count exact.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kobe.break_glass.requests:${adminId}`}, 0))`,
    );
    const [open] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(breakGlassGrants)
      .where(
        and(
          eq(breakGlassGrants.adminId, adminId),
          eq(breakGlassGrants.status, "pending"),
          sql`${breakGlassGrants.requestExpiresAt} > now()`,
        ),
      );
    if ((open?.n ?? 0) >= BREAK_GLASS_MAX_PENDING_PER_ADMIN) {
      return { ok: false, error: "too_many_pending" };
    }
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
    const queued = await enqueueNotifications(tx, row, "requested", { actorId: adminId });
    await recordAudit(tx, {
      action: "governance.break_glass.requested",
      teamId: row.teamId,
      target: { ...scopeTarget(row), durationMinutes: row.durationMinutes, ...queued },
    });
    return { ok: true, grant: row, queued };
  });
}

/**
 * Approves a pending request as `approverId` (D10): a second active install admin, or the
 * requester only when no other active install admin exists (flagged `selfApproved`).
 */
export async function approveGrant(
  db: KobeDb,
  approverId: string,
  grantId: string,
): Promise<GrantResult> {
  return db.transaction(async (tx): Promise<GrantResult> => {
    const current = await lockGrant(tx, grantId);
    if (!current) return { ok: false, error: "grant_not_found" };
    const subject = subjectError(current, approverId, "subject_cannot_approve");
    if (subject) return { ok: false, error: subject };
    if (current.status !== "pending") return { ok: false, error: "not_pending" };
    if (current.requestExpiresAt <= new Date()) return { ok: false, error: "request_lapsed" };
    if (current.adminId === approverId && !(await isSoleInstallAdmin(tx, approverId))) {
      return { ok: false, error: "self_approval_forbidden" };
    }
    const [row] = await tx
      .update(breakGlassGrants)
      .set({ status: "approved", approverId })
      .where(eq(breakGlassGrants.id, grantId))
      .returning();
    if (!row?.expiresAt) throw new Error("break-glass approval returned no window");
    const queued = await enqueueNotifications(tx, row, "approved", { actorId: approverId });
    await recordAudit(tx, {
      action: "governance.break_glass.approved",
      teamId: row.teamId,
      target: {
        ...scopeTarget(row),
        expiresAt: row.expiresAt.toISOString(),
        selfApproved: row.selfApproved,
        ...queued,
      },
    });
    return { ok: true, grant: row, queued };
  });
}

/** Denies a pending request; the requester withdraws instead (revoke). */
export async function denyGrant(db: KobeDb, by: string, grantId: string): Promise<GrantResult> {
  return db.transaction(async (tx): Promise<GrantResult> => {
    const current = await lockGrant(tx, grantId);
    if (!current) return { ok: false, error: "grant_not_found" };
    const subject = subjectError(current, by, "subject_cannot_decide");
    if (subject) return { ok: false, error: subject };
    if (current.status !== "pending") return { ok: false, error: "not_pending" };
    if (current.adminId === by) return { ok: false, error: "cannot_deny_own" };
    const [row] = await tx
      .update(breakGlassGrants)
      .set({ status: "denied", decidedBy: by })
      .where(eq(breakGlassGrants.id, grantId))
      .returning();
    if (!row) throw new Error("break-glass denial returned no row");
    const queued = await enqueueNotifications(tx, row, "denied", { actorId: by });
    await recordAudit(tx, {
      action: "governance.break_glass.denied",
      teamId: row.teamId,
      target: { grantId: row.id, ...queued },
    });
    return { ok: true, grant: row, queued };
  });
}

/** Revocation waits this long for in-flight reads and the audit chain (reads never wait this long). */
const REVOKE_LOCK_TIMEOUT = "30s";
const REVOKE_ATTEMPTS = 3;

/**
 * Ends a pending request (withdrawal) or an active grant (revocation) at once: the next read is
 * refused, and a read in flight finishes first (it holds the grant row in share mode). Revocation
 * outranks reads: it waits up to 30 s for locks (reads give up after 5 s) and retries a busy
 * audit chain, so a flood of reads can't keep a grant alive.
 */
export async function revokeGrant(db: KobeDb, by: string, grantId: string): Promise<GrantResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await revokeOnce(db, by, grantId);
    } catch (err) {
      if (!(err instanceof AuditBusyError) || attempt >= REVOKE_ATTEMPTS) throw err;
    }
  }
}

async function revokeOnce(db: KobeDb, by: string, grantId: string): Promise<GrantResult> {
  return db.transaction(async (tx): Promise<GrantResult> => {
    const current = await lockGrant(tx, grantId, REVOKE_LOCK_TIMEOUT);
    if (!current) return { ok: false, error: "grant_not_found" };
    const subject = subjectError(current, by, "subject_cannot_decide");
    if (subject) return { ok: false, error: subject };
    const status = effectiveStatus(current);
    if (status !== "pending" && status !== "active") return { ok: false, error: "not_open" };
    const [row] = await tx
      .update(breakGlassGrants)
      .set({ status: "revoked", decidedBy: by })
      .where(eq(breakGlassGrants.id, grantId))
      .returning();
    if (!row) throw new Error("break-glass revocation returned no row");
    const wasActive = status === "active";
    const queued = await enqueueNotifications(tx, row, "revoked", { actorId: by, wasActive });
    await recordAudit(tx, {
      action: "governance.break_glass.revoked",
      teamId: row.teamId,
      target: { grantId: row.id, wasActive, ...queued },
    });
    return { ok: true, grant: row, queued };
  });
}

/** Most grants one sweep expires; the next run continues. */
const SWEEP_BATCH = 100;

/** Expires one due grant in its own transaction (each needs its own team context), or none. */
async function expireOne(db: KobeDb): Promise<GrantRow | null> {
  return db.transaction(async (tx) => {
    const [due] = await tx
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
      .limit(1)
      .for("update", { skipLocked: true });
    if (!due) return null;
    const [row] = await tx
      .update(breakGlassGrants)
      .set({ status: "expired" })
      .where(eq(breakGlassGrants.id, due.id))
      .returning();
    if (!row) throw new Error("break-glass expiry returned no row");
    const wasActive = due.status === "approved";
    const queued = await enqueueNotifications(tx, row, "expired", { actorId: null, wasActive });
    await recordAudit(tx, {
      action: "governance.break_glass.expired",
      actor: SYSTEM_ACTOR,
      teamId: row.teamId,
      target: { grantId: row.id, wasActive, ...queued },
    });
    return row;
  });
}

/**
 * Records the end of grants whose window is over and requests nobody decided in time (system
 * actor), queuing their notifications. Access never waits for this: reads check `expires_at`
 * themselves. Safe on every replica at once: rows are claimed with SKIP LOCKED.
 */
export async function expireDueGrants(db: KobeDb): Promise<GrantRow[]> {
  const expired: GrantRow[] = [];
  for (let i = 0; i < SWEEP_BATCH; i++) {
    const row = await expireOne(db);
    if (!row) break;
    expired.push(row);
  }
  return expired;
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

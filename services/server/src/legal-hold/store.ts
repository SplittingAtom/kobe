import {
  desc,
  eq,
  inArray,
  legalHolds,
  sql,
  teams,
  users,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { activeInstallAdmins } from "../break-glass/store.js";
import type { RequestHoldBody } from "./schemas.js";

/**
 * Legal holds (spec D18, KOBE-17): request, two-person approval, denial or withdrawal, and a
 * release that needs a second install admin too (D10's rule; a single-admin install
 * self-approves, flagged). Every change runs in one transaction with the hold row locked and its
 * audit event as the last write. The `legal_holds_guard` trigger enforces the same rules in
 * Postgres; the checks here exist to answer with clear errors. Purge jobs consult holds through
 * `isUnderLegalHold()` / `legal_hold_covers()` in @kobe/db.
 *
 * A hold is confidential: it is invisible to the held user (404 everywhere, even an install
 * admin), and its audit events carry neither the held user's id nor the reason.
 */

export type HoldRow = typeof legalHolds.$inferSelect;
export type HoldScope = "team" | "user";

export type HoldError =
  | "team_not_found"
  | "user_not_found"
  | "subject_is_requester"
  | "hold_not_found"
  | "not_pending"
  | "not_active"
  | "self_approval_forbidden"
  | "cannot_deny_own"
  | "not_requester"
  | "release_pending"
  | "no_release_request"
  | "release_self_approval_forbidden"
  | "cannot_deny_own_release"
  | "not_release_requester";

export type HoldResult = { ok: true; hold: HoldRow } | { ok: false; error: HoldError };

/** Row lock wait. Approvals also wait for purges in flight (shared legal-hold lock). */
const LOCK_TIMEOUT = "30s";

/**
 * Whether `by` may approve their own request on this hold: no other active install admin exists
 * besides the held user (who can't approve), as the trigger decides (D10, flagged).
 */
export async function mayApproveOwn(
  db: KobeDb | KobeTx,
  by: string,
  hold: Pick<HoldRow, "userId">,
): Promise<boolean> {
  return (await activeInstallAdmins(db, by)).every((a) => a.id === hold.userId);
}

export function scopeOf(hold: Pick<HoldRow, "userId">): HoldScope {
  return hold.userId === null ? "team" : "user";
}

/**
 * The audit target of a hold: its id only. Not the held user, the team, the scope or the reason:
 * a held install admin who reads the install audit log must not learn of it (the hold row, behind
 * the console, keeps everything).
 */
function holdRef(hold: HoldRow) {
  return { holdId: hold.id };
}

/**
 * Locks the hold for a change; a hold about `viewerId` is not found (the held user never learns
 * of it, nor decides it).
 */
async function lockHold(tx: KobeTx, id: string, viewerId: string): Promise<HoldRow | undefined> {
  await tx.execute(sql`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
  const [row] = await tx.select().from(legalHolds).where(eq(legalHolds.id, id)).for("update");
  return row && row.userId !== viewerId ? row : undefined;
}

type Change = (tx: KobeTx, current: HoldRow) => Promise<HoldResult>;

/** Runs `change` on the locked hold in one transaction (audit last, inside `change`). */
function changeHold(db: KobeDb, by: string, id: string, change: Change): Promise<HoldResult> {
  return db.transaction(async (tx): Promise<HoldResult> => {
    const current = await lockHold(tx, id, by);
    if (!current) return { ok: false, error: "hold_not_found" };
    return change(tx, current);
  });
}

async function update(tx: KobeTx, id: string, set: Partial<HoldRow>): Promise<HoldRow> {
  const [row] = await tx.update(legalHolds).set(set).where(eq(legalHolds.id, id)).returning();
  if (!row) throw new Error("legal hold update returned no row");
  return row;
}

export async function requestHold(
  db: KobeDb,
  adminId: string,
  body: RequestHoldBody,
): Promise<HoldResult> {
  const [team] = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, body.teamId));
  if (!team) return { ok: false, error: "team_not_found" };
  if (body.userId !== undefined) {
    if (body.userId === adminId) return { ok: false, error: "subject_is_requester" };
    // Not necessarily a member any more: offboarding keeps a removed member's data for 30 days
    // (KOBE-28), and a hold must be able to keep it longer.
    const [subject] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, body.userId));
    if (!subject) return { ok: false, error: "user_not_found" };
  }
  return db.transaction(async (tx): Promise<HoldResult> => {
    const [row] = await tx
      .insert(legalHolds)
      .values({
        teamId: body.teamId,
        userId: body.userId ?? null,
        reason: body.reason,
        placedBy: adminId,
      })
      .returning();
    if (!row) throw new Error("legal hold insert returned no row");
    await recordAudit(tx, { action: "governance.legal_hold.requested", target: holdRef(row) });
    return { ok: true, hold: row };
  });
}

/** Places a pending hold: a second install admin, or the requester on a single-admin install. */
export function approveHold(db: KobeDb, by: string, id: string): Promise<HoldResult> {
  return changeHold(db, by, id, async (tx, current) => {
    if (current.status !== "pending") return { ok: false, error: "not_pending" };
    if (current.placedBy === by && !(await mayApproveOwn(tx, by, current))) {
      return { ok: false, error: "self_approval_forbidden" };
    }
    const row = await update(tx, id, { status: "active", approvedBy: by });
    await recordAudit(tx, {
      action: "governance.legal_hold.placed",
      target: { ...holdRef(row), selfApproved: row.selfApproved },
    });
    return { ok: true, hold: row };
  });
}

/** Another install admin turns a pending hold down; the requester withdraws instead. */
export function denyHold(db: KobeDb, by: string, id: string): Promise<HoldResult> {
  return changeHold(db, by, id, async (tx, current) => {
    if (current.status !== "pending") return { ok: false, error: "not_pending" };
    if (current.placedBy === by) return { ok: false, error: "cannot_deny_own" };
    const row = await update(tx, id, { status: "denied", closedBy: by });
    await recordAudit(tx, { action: "governance.legal_hold.denied", target: { holdId: row.id } });
    return { ok: true, hold: row };
  });
}

export function withdrawHold(db: KobeDb, by: string, id: string): Promise<HoldResult> {
  return changeHold(db, by, id, async (tx, current) => {
    if (current.status !== "pending") return { ok: false, error: "not_pending" };
    if (current.placedBy !== by) return { ok: false, error: "not_requester" };
    const row = await update(tx, id, { status: "withdrawn", closedBy: by });
    await recordAudit(tx, {
      action: "governance.legal_hold.withdrawn",
      target: { holdId: row.id },
    });
    return { ok: true, hold: row };
  });
}

/** Asks to end an active hold; it stays in force until a second install admin approves. */
export function requestRelease(
  db: KobeDb,
  by: string,
  id: string,
  reason: string,
): Promise<HoldResult> {
  return changeHold(db, by, id, async (tx, current) => {
    if (current.status !== "active") return { ok: false, error: "not_active" };
    if (current.releaseRequestedBy !== null) return { ok: false, error: "release_pending" };
    const row = await update(tx, id, {
      releaseRequestedBy: by,
      releaseRequestedAt: new Date(),
      releaseReason: reason,
    });
    await recordAudit(tx, {
      action: "governance.legal_hold.release_requested",
      target: { holdId: row.id },
    });
    return { ok: true, hold: row };
  });
}

/** Ends the hold: purges of its data may resume. */
export function approveRelease(db: KobeDb, by: string, id: string): Promise<HoldResult> {
  return changeHold(db, by, id, async (tx, current) => {
    if (current.status !== "active") return { ok: false, error: "not_active" };
    if (current.releaseRequestedBy === null) return { ok: false, error: "no_release_request" };
    if (current.releaseRequestedBy === by && !(await mayApproveOwn(tx, by, current))) {
      return { ok: false, error: "release_self_approval_forbidden" };
    }
    const row = await update(tx, id, { status: "released", releasedBy: by });
    await recordAudit(tx, {
      action: "governance.legal_hold.released",
      target: { ...holdRef(row), selfApproved: row.releaseSelfApproved },
    });
    return { ok: true, hold: row };
  });
}

const CANCELLED_RELEASE = {
  releaseRequestedBy: null,
  releaseRequestedAt: null,
  releaseReason: null,
} as const;

/** Another install admin turns the release down; the hold stays in force. */
export function denyRelease(db: KobeDb, by: string, id: string): Promise<HoldResult> {
  return changeHold(db, by, id, async (tx, current) => {
    if (current.status !== "active") return { ok: false, error: "not_active" };
    if (current.releaseRequestedBy === null) return { ok: false, error: "no_release_request" };
    if (current.releaseRequestedBy === by) return { ok: false, error: "cannot_deny_own_release" };
    const row = await update(tx, id, CANCELLED_RELEASE);
    await recordAudit(tx, {
      action: "governance.legal_hold.release_denied",
      target: { holdId: row.id },
    });
    return { ok: true, hold: row };
  });
}

export function withdrawRelease(db: KobeDb, by: string, id: string): Promise<HoldResult> {
  return changeHold(db, by, id, async (tx, current) => {
    if (current.status !== "active") return { ok: false, error: "not_active" };
    if (current.releaseRequestedBy === null) return { ok: false, error: "no_release_request" };
    if (current.releaseRequestedBy !== by) return { ok: false, error: "not_release_requester" };
    const row = await update(tx, id, CANCELLED_RELEASE);
    await recordAudit(tx, {
      action: "governance.legal_hold.release_withdrawn",
      target: { holdId: row.id },
    });
    return { ok: true, hold: row };
  });
}

type Person = { id: string; name: string; email: string };

export interface HoldDetail {
  readonly hold: HoldRow;
  readonly team: { id: string; slug: string; name: string };
  readonly subject: Person | null;
  readonly requestedBy: Person;
  readonly approvedBy: Person | null;
  readonly closedBy: Person | null;
  readonly releaseRequestedBy: Person | null;
  readonly releasedBy: Person | null;
}

/** Joins each hold's people and team (two queries, whatever the page size). */
async function withDetails(db: KobeDb, rows: readonly HoldRow[]): Promise<HoldDetail[]> {
  if (rows.length === 0) return [];
  const userIds = [
    ...new Set(
      rows
        .flatMap((r) => [
          r.userId,
          r.placedBy,
          r.approvedBy,
          r.closedBy,
          r.releaseRequestedBy,
          r.releasedBy,
        ])
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
  return rows.map((hold) => {
    const team = teamById.get(hold.teamId);
    const requestedBy = byId.get(hold.placedBy);
    if (!team || !requestedBy) throw new Error("legal hold references a missing row");
    return {
      hold,
      team,
      subject: find(hold.userId),
      requestedBy,
      approvedBy: find(hold.approvedBy),
      closedBy: find(hold.closedBy),
      releaseRequestedBy: find(hold.releaseRequestedBy),
      releasedBy: find(hold.releasedBy),
    };
  });
}

/** Holds about `viewerId` are left out: the held user never sees them. */
const notAbout = (viewerId: string) => sql`${legalHolds.userId} IS DISTINCT FROM ${viewerId}::uuid`;

/** Holds with their people and team, newest first (install view). */
export async function listHolds(db: KobeDb, viewerId: string, limit = 200): Promise<HoldDetail[]> {
  const rows = await db
    .select()
    .from(legalHolds)
    .where(notAbout(viewerId))
    .orderBy(desc(legalHolds.requestedAt), desc(legalHolds.id))
    .limit(limit);
  return withDetails(db, rows);
}

export async function getHold(
  db: KobeDb,
  id: string,
  viewerId: string,
): Promise<HoldDetail | undefined> {
  const rows = await db
    .select()
    .from(legalHolds)
    .where(sql`${legalHolds.id} = ${id}::uuid AND ${notAbout(viewerId)}`);
  return (await withDetails(db, rows))[0];
}

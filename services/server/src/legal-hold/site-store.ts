import { desc, eq, inArray, siteLegalHolds, sql, users, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { activeSiteAdmins } from "../break-glass/store.js";

/**
 * Site-wide legal hold (v1.3 SM28, KOBE-647): a hold on the Site's own memory, which belongs to
 * no team. Same lifecycle and two-person rule as Workspace holds (`store.ts`, D10, D18): a site
 * admin requests, a second site admin places it (a single-admin site self-approves, flagged), and a
 * release needs a second admin too. The `site_legal_holds_guard` trigger enforces the same rules
 * in Postgres; the checks here exist to answer with clear errors. While one is active, every
 * delete of Site items and versions fails with KH001 (0225), and the server skips them first
 * (`site-memory-hold.ts`). Audit: `governance.site_legal_hold.*`, the hold id only.
 */

export type SiteHoldRow = typeof siteLegalHolds.$inferSelect;

export type SiteHoldError =
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

export type SiteHoldResult = { ok: true; hold: SiteHoldRow } | { ok: false; error: SiteHoldError };

/** Row lock wait. Approvals also wait for purges in flight (shared legal-hold lock). */
const LOCK_TIMEOUT = "30s";

/** No other active site admin: the requester may approve their own request (flagged). */
export async function siteHoldSoleAdmin(db: KobeDb | KobeTx, by: string): Promise<boolean> {
  return (await activeSiteAdmins(db, by)).length === 0;
}

type Change = (tx: KobeTx, current: SiteHoldRow) => Promise<SiteHoldResult>;

/** Runs `change` on the locked hold in one transaction (audit last, inside `change`). */
function changeHold(db: KobeDb, id: string, change: Change): Promise<SiteHoldResult> {
  return db.transaction(async (tx): Promise<SiteHoldResult> => {
    await tx.execute(sql`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
    const [current] = await tx
      .select()
      .from(siteLegalHolds)
      .where(eq(siteLegalHolds.id, id))
      .for("update");
    if (!current) return { ok: false, error: "hold_not_found" };
    return change(tx, current);
  });
}

async function update(tx: KobeTx, id: string, set: Partial<SiteHoldRow>): Promise<SiteHoldRow> {
  const [row] = await tx
    .update(siteLegalHolds)
    .set(set)
    .where(eq(siteLegalHolds.id, id))
    .returning();
  if (!row) throw new Error("site legal hold update returned no row");
  return row;
}

/**
 * Asks for a Site-wide hold. Several may be open at once (one per matter, as Workspace holds):
 * Site memory stays held while any of them is active.
 */
export function requestSiteHold(db: KobeDb, by: string, reason: string): Promise<SiteHoldResult> {
  return db.transaction(async (tx): Promise<SiteHoldResult> => {
    const [row] = await tx.insert(siteLegalHolds).values({ reason, placedBy: by }).returning();
    if (!row) throw new Error("site legal hold insert returned no row");
    await recordAudit(tx, {
      action: "governance.site_legal_hold.requested",
      target: { holdId: row.id },
    });
    return { ok: true, hold: row };
  });
}

/** Places a pending hold: a second site admin, or the requester on a single-admin site. */
export function approveSiteHold(db: KobeDb, by: string, id: string): Promise<SiteHoldResult> {
  return changeHold(db, id, async (tx, current) => {
    if (current.status !== "pending") return { ok: false, error: "not_pending" };
    if (current.placedBy === by && !(await siteHoldSoleAdmin(tx, by)))
      return { ok: false, error: "self_approval_forbidden" };
    const row = await update(tx, id, { status: "active", approvedBy: by });
    await recordAudit(tx, {
      action: "governance.site_legal_hold.placed",
      target: { holdId: row.id, selfApproved: row.selfApproved },
    });
    return { ok: true, hold: row };
  });
}

/** Another site admin turns a pending hold down; the requester withdraws instead. */
export function denySiteHold(db: KobeDb, by: string, id: string): Promise<SiteHoldResult> {
  return changeHold(db, id, async (tx, current) => {
    if (current.status !== "pending") return { ok: false, error: "not_pending" };
    if (current.placedBy === by) return { ok: false, error: "cannot_deny_own" };
    const row = await update(tx, id, { status: "denied", closedBy: by });
    await recordAudit(tx, {
      action: "governance.site_legal_hold.denied",
      target: { holdId: row.id },
    });
    return { ok: true, hold: row };
  });
}

export function withdrawSiteHold(db: KobeDb, by: string, id: string): Promise<SiteHoldResult> {
  return changeHold(db, id, async (tx, current) => {
    if (current.status !== "pending") return { ok: false, error: "not_pending" };
    if (current.placedBy !== by) return { ok: false, error: "not_requester" };
    const row = await update(tx, id, { status: "withdrawn", closedBy: by });
    await recordAudit(tx, {
      action: "governance.site_legal_hold.withdrawn",
      target: { holdId: row.id },
    });
    return { ok: true, hold: row };
  });
}

/** Asks to end an active hold; it stays in force until a second site admin approves. */
export function requestSiteRelease(
  db: KobeDb,
  by: string,
  id: string,
  reason: string,
): Promise<SiteHoldResult> {
  return changeHold(db, id, async (tx, current) => {
    if (current.status !== "active") return { ok: false, error: "not_active" };
    if (current.releaseRequestedBy !== null) return { ok: false, error: "release_pending" };
    const row = await update(tx, id, {
      releaseRequestedBy: by,
      releaseRequestedAt: new Date(),
      releaseReason: reason,
    });
    await recordAudit(tx, {
      action: "governance.site_legal_hold.release_requested",
      target: { holdId: row.id },
    });
    return { ok: true, hold: row };
  });
}

/** Ends the hold: Site memory purges and version pruning may resume. */
export function approveSiteRelease(db: KobeDb, by: string, id: string): Promise<SiteHoldResult> {
  return changeHold(db, id, async (tx, current) => {
    if (current.status !== "active") return { ok: false, error: "not_active" };
    if (current.releaseRequestedBy === null) return { ok: false, error: "no_release_request" };
    if (current.releaseRequestedBy === by && !(await siteHoldSoleAdmin(tx, by)))
      return { ok: false, error: "release_self_approval_forbidden" };
    const row = await update(tx, id, { status: "released", releasedBy: by });
    await recordAudit(tx, {
      action: "governance.site_legal_hold.released",
      target: { holdId: row.id, selfApproved: row.releaseSelfApproved },
    });
    return { ok: true, hold: row };
  });
}

const CANCELLED_RELEASE = {
  releaseRequestedBy: null,
  releaseRequestedAt: null,
  releaseReason: null,
} as const;

/** Another site admin turns the release down; the hold stays in force. */
export function denySiteRelease(db: KobeDb, by: string, id: string): Promise<SiteHoldResult> {
  return changeHold(db, id, async (tx, current) => {
    if (current.status !== "active") return { ok: false, error: "not_active" };
    if (current.releaseRequestedBy === null) return { ok: false, error: "no_release_request" };
    if (current.releaseRequestedBy === by) return { ok: false, error: "cannot_deny_own_release" };
    const row = await update(tx, id, CANCELLED_RELEASE);
    await recordAudit(tx, {
      action: "governance.site_legal_hold.release_denied",
      target: { holdId: row.id },
    });
    return { ok: true, hold: row };
  });
}

export function withdrawSiteRelease(db: KobeDb, by: string, id: string): Promise<SiteHoldResult> {
  return changeHold(db, id, async (tx, current) => {
    if (current.status !== "active") return { ok: false, error: "not_active" };
    if (current.releaseRequestedBy === null) return { ok: false, error: "no_release_request" };
    if (current.releaseRequestedBy !== by) return { ok: false, error: "not_release_requester" };
    const row = await update(tx, id, CANCELLED_RELEASE);
    await recordAudit(tx, {
      action: "governance.site_legal_hold.release_withdrawn",
      target: { holdId: row.id },
    });
    return { ok: true, hold: row };
  });
}

type Person = { id: string; name: string; email: string };

export interface SiteHoldDetail {
  readonly hold: SiteHoldRow;
  readonly requestedBy: Person;
  readonly approvedBy: Person | null;
  readonly closedBy: Person | null;
  readonly releaseRequestedBy: Person | null;
  readonly releasedBy: Person | null;
}

/** Joins each hold's people (one query, whatever the page size). */
async function withPeople(db: KobeDb, rows: readonly SiteHoldRow[]): Promise<SiteHoldDetail[]> {
  if (rows.length === 0) return [];
  const ids = [
    ...new Set(
      rows
        .flatMap((r) => [r.placedBy, r.approvedBy, r.closedBy, r.releaseRequestedBy, r.releasedBy])
        .filter((v) => v !== null),
    ),
  ];
  const people = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));
  const byId = new Map(people.map((p) => [p.id, p]));
  const find = (id: string | null) => (id === null ? null : (byId.get(id) ?? null));
  return rows.map((hold) => {
    const requestedBy = byId.get(hold.placedBy);
    if (!requestedBy) throw new Error("site legal hold references a missing user");
    return {
      hold,
      requestedBy,
      approvedBy: find(hold.approvedBy),
      closedBy: find(hold.closedBy),
      releaseRequestedBy: find(hold.releaseRequestedBy),
      releasedBy: find(hold.releasedBy),
    };
  });
}

/** Site-wide holds with their people, newest first. */
export async function listSiteHolds(db: KobeDb, limit = 200): Promise<SiteHoldDetail[]> {
  const rows = await db
    .select()
    .from(siteLegalHolds)
    .orderBy(desc(siteLegalHolds.requestedAt), desc(siteLegalHolds.id))
    .limit(limit);
  return withPeople(db, rows);
}

export async function getSiteHold(db: KobeDb, id: string): Promise<SiteHoldDetail | undefined> {
  const rows = await db.select().from(siteLegalHolds).where(eq(siteLegalHolds.id, id));
  return (await withPeople(db, rows))[0];
}

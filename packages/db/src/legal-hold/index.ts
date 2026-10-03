import { and, eq, sql } from "drizzle-orm";
import type { KobeDb, KobeTx } from "../client.js";
import { legalHolds } from "../schema/legal-holds.js";

/**
 * Legal hold for purge jobs (spec D18, KOBE-17). A hold suspends every purge of a team's data, or
 * of one user's data in that team: retention purges and Trash purges (KOBE-18), offboarding volume
 * deletion (KOBE-28), and the audit log's IP and user-agent erasure.
 *
 * How a purge job uses it:
 *  1. In the purge transaction, call `lockLegalHolds(tx)` first. Approving a hold waits for purges
 *     holding it, and purges that start later see the hold, so nothing is deleted between
 *     "checked" and "deleted".
 *  2. Exclude held data: per item with `isUnderLegalHold(tx, teamId, ownerUserId)`, in bulk with
 *     `legalHoldsForTeam(tx, teamId)`, or in SQL with `WHERE NOT legal_hold_covers(team_id,
 *     owner_user_id)`.
 *  3. Keep purge transactions short (batches): an approval waits for them.
 *
 * The database backs this up: deleting a held thread or thread entry fails with SQLSTATE
 * `LEGAL_HOLD_SQLSTATE` (triggers `threads_legal_hold`, `thread_entries_legal_hold`). Guard any new
 * purgeable team table the same way.
 */

/** SQLSTATE raised when a delete (or an audit erasure) would touch held data. */
export const LEGAL_HOLD_SQLSTATE = "KH001";

type Executor = KobeDb | KobeTx;

/**
 * Takes the legal-hold lock in shared mode until the transaction ends. Call it at the start of
 * every purge transaction, before checking for holds.
 */
export async function lockLegalHolds(tx: KobeTx): Promise<void> {
  await tx.execute(sql`SELECT public.legal_hold_lock_shared()`);
}

/**
 * Whether an active hold suspends purges of this data.
 * - With `userId`: a team-wide hold on `teamId`, or a hold on that user in `teamId`.
 * - Without `userId`: **any** active hold in the team (a team-level purge must not run past a hold
 *   on one of its users). Use `legalHoldsForTeam` to purge around user holds instead.
 */
export async function isUnderLegalHold(
  db: Executor,
  teamId: string,
  userId?: string | null,
): Promise<boolean> {
  const subject = userId
    ? sql`(${legalHolds.userId} IS NULL OR ${legalHolds.userId} = ${userId}::uuid)`
    : sql`true`;
  const [row] = await db
    .select({ held: sql<boolean>`true` })
    .from(legalHolds)
    .where(and(eq(legalHolds.status, "active"), eq(legalHolds.teamId, teamId), subject))
    .limit(1);
  return row !== undefined;
}

export interface TeamLegalHolds {
  /** A team-wide hold is active: purge nothing of this team. */
  readonly team: boolean;
  /** Users with an active hold in this team: purge nothing they own. */
  readonly userIds: readonly string[];
}

/** The active holds of one team, for purges that skip held users instead of the whole team. */
export async function legalHoldsForTeam(db: Executor, teamId: string): Promise<TeamLegalHolds> {
  const rows = await db
    .select({ userId: legalHolds.userId })
    .from(legalHolds)
    .where(and(eq(legalHolds.status, "active"), eq(legalHolds.teamId, teamId)));
  return {
    team: rows.some((r) => r.userId === null),
    userIds: [...new Set(rows.flatMap((r) => (r.userId === null ? [] : [r.userId])))],
  };
}

/** Whether `err` is the database refusing to delete or erase held data. */
export function isLegalHoldViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return (e?.cause?.code ?? e?.code) === LEGAL_HOLD_SQLSTATE;
}

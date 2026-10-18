import {
  SYSTEM_ACTOR,
  lockLegalHolds,
  sql,
  teams,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * Workbench drafts in the retention pass and offboarding (KOBE-320, SK11: drafts follow team
 * retention and offboarding). A draft is purged, with its files (the key cascades),
 *  - once nobody changed it for longer than the team's retention window (`purgeSkillDrafts`);
 *  - 30 days after its author stopped being an active member of the team (`sweepDepartedDrafts`,
 *    run by the offboarding sweep): removed, deactivated, or gone with no sandbox ever woken; a
 *    return within the 30 days keeps the drafts.
 * A legal hold never stops or shows in either (D18): the database copies what a hold covers (the
 * author or a file's writer) into the history tables as the rows go (`0142_skill_drafts_rls`), so
 * a held draft past its window looks purged like any other. `purgeReleasedDraftHistory` deletes
 * those copies once no hold covers them. Audited with counts only.
 */

const BATCH = 200;

export interface DraftPurgeCounts {
  readonly drafts: number;
}

export const NO_DRAFT_PURGE: DraftPurgeCounts = { drafts: 0 };

type Reason = "retention" | "offboarding" | "hold_released";

async function audited(tx: KobeTx, teamId: string, reason: Reason, rows: number) {
  if (rows === 0) return;
  await recordAudit(tx, {
    action: "retention.skill_drafts_purged",
    actor: SYSTEM_ACTOR,
    teamId,
    target: { reason, rows },
  });
}

/** Repeats one batch in its own team transaction (legal-hold lock first) until a short one. */
async function batches(
  db: KobeDb,
  teamId: string,
  stop: (() => boolean) | undefined,
  one: (tx: KobeTx) => Promise<number>,
): Promise<number> {
  let total = 0;
  for (;;) {
    if (stop?.()) break;
    const n = await withTeam(db, teamId, async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
      await lockLegalHolds(tx);
      return one(tx);
    });
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

/** Drafts unchanged since before `cutoff` (the team's window); held content goes to history. */
export async function purgeSkillDrafts(
  db: KobeDb,
  teamId: string,
  cutoff: Date | null,
  options: { readonly stop?: () => boolean } = {},
): Promise<DraftPurgeCounts> {
  if (cutoff === null) return NO_DRAFT_PURGE;
  const drafts = await batches(db, teamId, options.stop, async (tx) => {
    const res = await tx.execute(sql`
      DELETE FROM skill_drafts d
       WHERE d.team_id = ${teamId} AND d.id IN (
         SELECT k.id FROM skill_drafts k
          WHERE k.team_id = ${teamId} AND k.updated_at < ${cutoff.toISOString()}
          ORDER BY k.updated_at, k.id LIMIT ${BATCH})`);
    const n = res.rowCount ?? 0;
    await audited(tx, teamId, "retention", n);
    return n;
  });
  return { drafts };
}

/** A hold's copies of drafts and files that no hold covers any more (author nor writer). */
export async function purgeReleasedDraftHistory(
  db: KobeDb,
  teamId: string,
  options: { readonly stop?: () => boolean } = {},
): Promise<{ readonly rows: number }> {
  const rows = await batches(db, teamId, options.stop, async (tx) => {
    const files = await tx.execute(sql`
      DELETE FROM skill_draft_file_history h
       WHERE h.team_id = ${teamId} AND h.id IN (
         SELECT k.id FROM skill_draft_file_history k
          WHERE k.team_id = ${teamId}
            AND NOT public.skill_draft_held(k.team_id, k.owner_user_id, k.written_by)
          ORDER BY k.id LIMIT ${BATCH})`);
    const drafts = await tx.execute(sql`
      DELETE FROM skill_draft_history h
       WHERE h.team_id = ${teamId} AND h.id IN (
         SELECT k.id FROM skill_draft_history k
          WHERE k.team_id = ${teamId}
            AND NOT public.skill_draft_held(k.team_id, k.owner_user_id, k.updated_by)
          ORDER BY k.id LIMIT ${BATCH})`);
    const n = (files.rowCount ?? 0) + (drafts.rowCount ?? 0);
    await audited(tx, teamId, "hold_released", n);
    return Math.max(files.rowCount ?? 0, drafts.rowCount ?? 0);
  });
  return { rows };
}

/** The author is an active member of the draft's team (a member, not deactivated). */
const ACTIVE_AUTHOR = sql`EXISTS (
  SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id
   WHERE m.team_id = d.team_id AND m.user_id = d.owner_user_id AND u.deactivated_at IS NULL)`;

/**
 * One team's departed authors: marks drafts whose author is no longer an active member (the
 * departure is noted the first time the sweep sees it), clears the mark of an author who came
 * back, and deletes drafts marked longer than `retainDays` ago. Returns how many were deleted.
 */
export async function sweepDepartedDraftsInTeam(
  db: KobeDb,
  teamId: string,
  retainDays: number,
  options: { readonly stop?: () => boolean } = {},
): Promise<number> {
  await withTeam(db, teamId, async (tx) => {
    await tx.execute(sql`
      UPDATE skill_drafts d SET owner_departed_at = now()
       WHERE d.team_id = ${teamId} AND d.owner_departed_at IS NULL AND NOT ${ACTIVE_AUTHOR}`);
    await tx.execute(sql`
      UPDATE skill_drafts d SET owner_departed_at = NULL
       WHERE d.team_id = ${teamId} AND d.owner_departed_at IS NOT NULL AND ${ACTIVE_AUTHOR}`);
  });
  return batches(db, teamId, options.stop, async (tx) => {
    const res = await tx.execute(sql`
      DELETE FROM skill_drafts d
       WHERE d.team_id = ${teamId} AND d.id IN (
         SELECT k.id FROM skill_drafts k
          WHERE k.team_id = ${teamId}
            AND k.owner_departed_at <= now() - make_interval(days => ${retainDays})
          ORDER BY k.owner_departed_at, k.id LIMIT ${BATCH})
         AND NOT ${ACTIVE_AUTHOR}`);
    const n = res.rowCount ?? 0;
    await audited(tx, teamId, "offboarding", n);
    return n;
  });
}

/** Every team's departed authors (the offboarding sweep). Returns the drafts deleted. */
export async function sweepDepartedDrafts(
  db: KobeDb,
  retainDays: number,
  options: { readonly stop?: () => boolean } = {},
): Promise<number> {
  let deleted = 0;
  for (const team of await db.select({ id: teams.id }).from(teams)) {
    if (options.stop?.()) break;
    deleted += await sweepDepartedDraftsInTeam(db, team.id, retainDays, options);
  }
  return deleted;
}

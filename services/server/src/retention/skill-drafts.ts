import { SYSTEM_ACTOR, lockLegalHolds, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * Workbench drafts in the retention pass and offboarding (KOBE-320, SK11: drafts follow team
 * retention and offboarding). A draft is purged, with its files (the key cascades),
 *  - once nobody changed it for longer than the team's retention window,
 *  - with a departed author's data at offboarding (`purgeDepartedDraftsInTx`, not audited on its
 *    own, like shared eval cases: the step's own audit row covers it),
 * and never while a legal hold covers its author: each batch takes the legal-hold lock first and
 * selects unheld drafts only. Audited with counts only.
 */

const BATCH = 200;

export interface DraftPurgeCounts {
  readonly drafts: number;
}

export const NO_DRAFT_PURGE: DraftPurgeCounts = { drafts: 0 };

/** Drafts unchanged since before `cutoff` (the team's window), unheld, in batches. */
export async function purgeSkillDrafts(
  db: KobeDb,
  teamId: string,
  cutoff: Date | null,
  options: { readonly stop?: () => boolean } = {},
): Promise<DraftPurgeCounts> {
  if (cutoff === null) return NO_DRAFT_PURGE;
  let drafts = 0;
  for (;;) {
    if (options.stop?.()) break;
    const n = await withTeam(db, teamId, async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
      await lockLegalHolds(tx);
      const res = await tx.execute(sql`
        DELETE FROM skill_drafts d
         WHERE d.team_id = ${teamId} AND d.id IN (
           SELECT k.id FROM skill_drafts k
            WHERE k.team_id = ${teamId} AND k.updated_at < ${cutoff.toISOString()}
              AND NOT public.legal_hold_covers(k.team_id, k.owner_user_id)
            ORDER BY k.updated_at, k.id LIMIT ${BATCH})`);
      const rows = res.rowCount ?? 0;
      if (rows > 0)
        await recordAudit(tx, {
          action: "retention.skill_drafts_purged",
          actor: SYSTEM_ACTOR,
          teamId,
          target: { rows },
        });
      return rows;
    });
    drafts += n;
    if (n < BATCH) break;
  }
  return { drafts };
}

/**
 * One batch of a departed author's drafts, shared ones included, inside the offboarding step's
 * transaction (which holds the legal-hold lock and has checked the member's hold; the batch
 * re-checks it). Returns how many went.
 */
export async function purgeDepartedDraftsInTx(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<number> {
  await lockLegalHolds(tx);
  const res = await tx.execute(sql`
    DELETE FROM skill_drafts d
     WHERE d.team_id = ${teamId} AND d.id IN (
       SELECT k.id FROM skill_drafts k
        WHERE k.team_id = ${teamId} AND k.owner_user_id = ${userId}
          AND NOT public.legal_hold_covers(k.team_id, k.owner_user_id)
        ORDER BY k.id LIMIT ${BATCH})`);
  return res.rowCount ?? 0;
}

export const DRAFT_BATCH = BATCH;

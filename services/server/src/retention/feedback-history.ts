import { SYSTEM_ACTOR, lockLegalHolds, sql, withTeam, type KobeDb } from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * Answer feedback kept for a legal hold (KOBE-275 review R3): `answer_feedback_history` rows are
 * copies of ratings a member changed or cleared while a hold covered the thread's owner or the
 * rater. Once no hold covers either (`answer_feedback_held`, which checks both), the copies are
 * purged by the retention pass: held data stays only as long as the hold. Each batch runs in one
 * team transaction that takes the legal-hold lock first, so a hold approved meanwhile waits and
 * one placed earlier wins (the table's delete guard backs this up for the owner). Audited with the
 * count only.
 */

const BATCH = 500;

export interface FeedbackHistoryCounts {
  readonly rows: number;
}

export async function purgeReleasedFeedbackHistory(
  db: KobeDb,
  teamId: string,
  options: { readonly stop?: () => boolean } = {},
): Promise<FeedbackHistoryCounts> {
  let rows = 0;
  for (;;) {
    if (options.stop?.()) break;
    const deleted = await withTeam(db, teamId, async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
      await lockLegalHolds(tx);
      const res = await tx.execute(sql`
        DELETE FROM answer_feedback_history h
         WHERE h.team_id = ${teamId} AND h.id IN (
           SELECT k.id FROM answer_feedback_history k
            WHERE k.team_id = ${teamId}
              AND NOT public.answer_feedback_held(k.team_id, k.thread_id, k.user_id)
            ORDER BY k.id LIMIT ${BATCH})`);
      const n = res.rowCount ?? 0;
      if (n > 0) {
        await recordAudit(tx, {
          action: "retention.feedback_history_purged",
          actor: SYSTEM_ACTOR,
          teamId,
          target: { rows: n },
        });
      }
      return n;
    });
    rows += deleted;
    if (deleted < BATCH) break;
  }
  return { rows };
}

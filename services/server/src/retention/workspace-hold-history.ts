import { SYSTEM_ACTOR, lockLegalHolds, sql, withTeam, type KobeDb } from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * Moved workspace files' old paths kept for a legal hold (KOBE-304,
 * `workspace_file_hold_history`): once no hold covers the member, the copies are purged by the
 * retention pass, so held data stays only as long as the hold. Each batch runs in one team
 * transaction that takes the legal-hold lock first, so a hold approved meanwhile waits and one
 * placed earlier wins (the table's delete guard backs this up). Audited with the count only.
 */

const BATCH = 500;

export interface WorkspaceHoldHistoryCounts {
  readonly rows: number;
}

export async function purgeReleasedWorkspaceHoldHistory(
  db: KobeDb,
  teamId: string,
  options: { readonly stop?: () => boolean } = {},
): Promise<WorkspaceHoldHistoryCounts> {
  let rows = 0;
  for (;;) {
    if (options.stop?.()) break;
    const deleted = await withTeam(db, teamId, async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
      await lockLegalHolds(tx);
      const res = await tx.execute(sql`
        DELETE FROM workspace_file_hold_history h
         WHERE h.team_id = ${teamId} AND h.id IN (
           SELECT k.id FROM workspace_file_hold_history k
            WHERE k.team_id = ${teamId} AND NOT public.legal_hold_covers(k.team_id, k.user_id)
            ORDER BY k.id LIMIT ${BATCH})`);
      const n = res.rowCount ?? 0;
      if (n > 0) {
        await recordAudit(tx, {
          action: "retention.workspace_hold_history_purged",
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

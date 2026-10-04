import { recordAudit } from "../audit/record.js";
import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { TRASH_RETENTION_DAYS } from "./periods.js";
import { purgeThreads, type PurgeBatchResult } from "./purge.js";

/**
 * "Delete forever" from Trash (spec D18): the owner, and only the owner, hard-deletes one of their
 * threads in Trash before the 30 days are up. Team admins can't (D18), nor can anyone else: the
 * thread is looked up by id, team and owner together, so another user's thread is "not found".
 *
 * Two steps, so a legal hold stays confidential:
 *  1. the request: the thread leaves Trash at once (its Trash date is moved past the 30-day window,
 *     so it is no longer listed or restorable) and `thread.purge_requested` is audited;
 *  2. the purge, as the retention job would do it (`thread.purged`, counts only). Under a hold the
 *     purge skips the thread; the nightly Trash purge deletes it once the hold is released. The
 *     user sees the same answer either way.
 */

export type DeleteForeverError = "thread_not_found" | "not_in_trash" | "thread_busy";

export type DeleteForeverResult =
  | { readonly ok: true; readonly purged: boolean }
  | { readonly ok: false; readonly error: DeleteForeverError };

const TRASH_INTERVAL = sql.raw(`interval '${TRASH_RETENTION_DAYS} days'`);

async function request(
  tx: KobeTx,
  teamId: string,
  userId: string,
  threadId: string,
): Promise<DeleteForeverError | null> {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '2s'`));
  const found = await tx.execute<{ in_trash: boolean; restorable: boolean; busy: boolean }>(sql`
    SELECT t.deleted_at IS NOT NULL AS in_trash,
           t.deleted_at > now() - ${TRASH_INTERVAL} AS restorable,
           EXISTS (SELECT 1 FROM runs r
                    WHERE r.team_id = t.team_id AND r.thread_id = t.id
                      AND r.status IN ('queued', 'running', 'waiting_approval')) AS busy
      FROM threads t
     WHERE t.team_id = ${teamId} AND t.id = ${threadId} AND t.owner_user_id = ${userId}
     FOR UPDATE OF t`);
  const row = found.rows[0];
  // Past the window it is already awaiting purge: gone for the user, like Trash listing says.
  if (!row || (row.in_trash && !row.restorable)) return "thread_not_found";
  if (!row.in_trash) return "not_in_trash";
  if (row.busy) return "thread_busy";
  await tx.execute(sql`
    UPDATE threads SET deleted_at = now() - ${TRASH_INTERVAL} - interval '1 second'
     WHERE team_id = ${teamId} AND id = ${threadId}`);
  await recordAudit(tx, {
    action: "thread.purge_requested",
    teamId,
    target: { threadId },
  });
  return null;
}

export async function deleteForever(
  db: KobeDb,
  viewer: { readonly teamId: string; readonly userId: string },
  threadId: string,
): Promise<DeleteForeverResult> {
  const { teamId, userId } = viewer;
  const error = await withTeam(db, teamId, (tx) => request(tx, teamId, userId, threadId));
  if (error) return { ok: false, error };
  const record = async (tx: KobeTx, counts: PurgeBatchResult) => {
    await recordAudit(tx, {
      action: "thread.purged",
      teamId,
      target: {
        threadId,
        entries: counts.entries,
        runs: counts.runs,
        events: counts.events,
        blobs: counts.blobs,
      },
    });
  };
  const outcome = await purgeThreads(
    db,
    teamId,
    { kind: "thread", threadId, ownerUserId: userId },
    record,
    { maxBatches: 1 },
  );
  return { ok: true, purged: outcome.counts.threads > 0 };
}

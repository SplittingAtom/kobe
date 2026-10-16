import { SERVER_CALL_EPILOGUE_MAX_MS } from "@kobe/protocol";
import { sql, type KobeTx } from "@kobe/db";
import { RUN_EVENTS_CHANNEL } from "./notify.js";

/**
 * Streams can still be open on a run this long after it ended: the epilogue window (KOBE-234)
 * plus a margin. Older runs have no open stream (a reconnect answers 204).
 */
const OPEN_AFTER_END_MS = SERVER_CALL_EPILOGUE_MAX_MS + 60_000;

/**
 * Tells every replica that who may watch the thread's runs changed (KOBE-221: a share revoked or
 * narrowed, the thread moved or went to Trash), so their open streams recheck the viewer at once
 * instead of at the next periodic revalidation (30 s). Inside the change's transaction: Postgres
 * delivers the notifications on commit, when the recheck already sees the new state, and never for
 * a change that rolled back. Ids only (`notify.ts`).
 */
export async function notifyThreadAccess(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<void> {
  await tx.execute(sql`
    SELECT pg_notify(${RUN_EVENTS_CHANNEL}, 'access:' || r.id::text)
      FROM runs r
     WHERE r.team_id = ${teamId} AND r.thread_id = ${threadId}
       AND r.events_compacted_at IS NULL
       AND (r.ended_at IS NULL
            OR r.ended_at > now() - ${OPEN_AFTER_END_MS}::int * interval '1 millisecond')`);
}

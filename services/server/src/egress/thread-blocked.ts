import { sql, type KobeTx } from "@kobe/db";
import {
  EVENT_PAYLOAD_SCHEMAS,
  THREAD_EGRESS_BLOCKED_MAX,
  type ThreadEgressBlockedResponse,
} from "@kobe/protocol";
import { findThread, type Viewer } from "../threads/repository.js";

type BlockedRow = ThreadEgressBlockedResponse["blocked"][number];

const payloadSchema = EVENT_PAYLOAD_SCHEMAS["egress.blocked"];

/**
 * `GET /v1/threads/{id}/egress-blocked` (KOBE-605): the thread's stored `egress.blocked` run
 * events, so each answer keeps its blocked cards after its run ended and after a reload (the live
 * stream only carries the run being followed). One row per (run, domain), the first, as the live
 * reducer keeps it (`apps/web/lib/chat/live.ts`); the newest {@link THREAD_EGRESS_BLOCKED_MAX},
 * oldest first. For whoever may read the thread; null = 404. A run whose events were compacted
 * (D18) has none.
 */
export async function readThreadBlocked(
  tx: KobeTx,
  viewer: Viewer,
  threadId: string,
): Promise<ThreadEgressBlockedResponse | null> {
  if (!(await findThread(tx, viewer, threadId))) return null;
  const teamId = viewer.teamId;
  const res = await tx.execute<{
    run_id: string;
    user_entry_id: string | null;
    seq: number;
    created_at: string | Date;
    payload: unknown;
  }>(sql`
    SELECT * FROM (
      SELECT * FROM (
        SELECT DISTINCT ON (e.run_id, e.payload->>'domain')
               e.run_id, r.user_entry_id, e.seq, e.created_at, e.payload
          FROM run_events e
          JOIN runs r ON r.team_id = e.team_id AND r.id = e.run_id
         WHERE e.team_id = ${teamId} AND r.team_id = ${teamId} AND r.thread_id = ${threadId}
           AND e.type = 'egress.blocked'
         ORDER BY e.run_id, e.payload->>'domain', e.seq
      ) firsts
      ORDER BY created_at DESC, run_id, seq DESC
      LIMIT ${THREAD_EGRESS_BLOCKED_MAX}
    ) newest
    ORDER BY created_at, run_id, seq`);
  const blocked = res.rows.flatMap((row): BlockedRow[] => {
    const payload = payloadSchema.safeParse(row.payload);
    if (!payload.success) return [];
    return [
      {
        run_id: row.run_id,
        user_entry_id: row.user_entry_id,
        seq: Number(row.seq),
        ts: new Date(row.created_at).toISOString(),
        payload: payload.data,
      },
    ];
  });
  return { blocked };
}

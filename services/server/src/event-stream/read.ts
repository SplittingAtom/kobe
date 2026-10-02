import type { KobeEvent } from "@kobe/protocol";
import { sql, withTeam, type KobeDb } from "@kobe/db";

/** Most events one read returns: what a stream holds in memory at a time. */
export const PAGE_MAX_ROWS = 50;
/** Byte budget per page (stored payload size); the first row is always included. */
export const PAGE_MAX_BYTES = 1024 * 1024;

export interface RunState {
  readonly ended: boolean;
  readonly compacted: boolean;
  readonly lastSeq: number;
}

export interface WatchableRun extends RunState {
  readonly runId: string;
  readonly threadId: string;
  readonly ownerUserId: string;
}

/** The run and its thread's owner, under the team's RLS; null when the team has no such run. */
export async function loadRun(
  db: KobeDb,
  teamId: string,
  runId: string,
): Promise<WatchableRun | null> {
  const result = await withTeam(db, teamId, (tx) =>
    tx.execute<{
      thread_id: string;
      owner_user_id: string;
      ended: boolean;
      compacted: boolean;
      last_seq: number;
    }>(sql`
      SELECT r.thread_id, t.owner_user_id, r.ended_at IS NOT NULL AS ended,
             r.events_compacted_at IS NOT NULL AS compacted, r.last_seq
        FROM runs r
        JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
       WHERE r.team_id = ${teamId} AND r.id = ${runId}`),
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    runId,
    threadId: row.thread_id,
    ownerUserId: row.owner_user_id,
    ended: row.ended,
    compacted: row.compacted,
    lastSeq: row.last_seq,
  };
}

export interface Page {
  /** null when the run no longer exists (thread purged). */
  readonly run: RunState | null;
  /** Events with seq > after, ascending and contiguous. */
  readonly events: KobeEvent[];
}

type PageRow = {
  ended: boolean;
  compacted: boolean;
  last_seq: number;
  seq: number | null;
  type: string | null;
  payload: Record<string, unknown> | null;
  created_at: Date | string | null;
};

/**
 * Events after `after`, at most PAGE_MAX_ROWS rows and about PAGE_MAX_BYTES, plus the run's state.
 * One statement, so the run state and the events come from the same snapshot: "ended and nothing
 * left" can't race a final event committed between two queries.
 */
export async function readPage(
  db: KobeDb,
  teamId: string,
  runId: string,
  after: number,
): Promise<Page> {
  const result = await withTeam(db, teamId, (tx) =>
    tx.execute<PageRow>(sql`
      SELECT r.ended_at IS NOT NULL AS ended, r.events_compacted_at IS NOT NULL AS compacted,
             r.last_seq, p.seq, p.type, p.payload, p.created_at
        FROM runs r
        LEFT JOIN LATERAL (
          SELECT q.seq, q.type, q.payload, q.created_at
            FROM (SELECT e.seq, e.type, e.payload, e.created_at,
                         sum(pg_column_size(e.payload)) OVER (ORDER BY e.seq)
                           - pg_column_size(e.payload) AS bytes_before
                    FROM run_events e
                   WHERE e.team_id = r.team_id AND e.run_id = r.id AND e.seq > ${after}
                   ORDER BY e.seq
                   LIMIT ${PAGE_MAX_ROWS}) q
           WHERE q.bytes_before < ${PAGE_MAX_BYTES}
        ) p ON true
       WHERE r.team_id = ${teamId} AND r.id = ${runId}
       ORDER BY p.seq`),
  );
  const first = result.rows[0];
  if (!first) return { run: null, events: [] };
  const run = { ended: first.ended, compacted: first.compacted, lastSeq: first.last_seq };
  const events: KobeEvent[] = [];
  for (const row of result.rows) {
    if (row.seq === null || row.type === null || row.created_at === null) continue;
    events.push({
      run_id: runId,
      seq: row.seq,
      ts: new Date(row.created_at).toISOString(),
      type: row.type,
      payload: row.payload ?? {},
    } as KobeEvent);
  }
  return { run, events };
}

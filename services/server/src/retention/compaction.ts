import { auditTimeout } from "./locks.js";
import { lockLegalHolds, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { COMPACTION_DAYS } from "./periods.js";

/**
 * `run_events` compaction (spec D18): 7 days after a run ended, its live event stream is folded
 * away. The conversation itself is in `thread_entries` (Pi's entries, mirrored as the run went), so
 * a compacted run keeps its final entries and only loses the replayable stream; the event-stream
 * route answers 410 `events_compacted` for it and clients render the entries (KOBE-31 contract).
 * `runs.events_compacted_at` marks the run, so each pass reads only uncompacted ended runs
 * (`runs_compaction_idx`). Held threads are skipped (KOBE-17: a hold suspends every purge; the
 * `run_events` delete guard backs this up).
 */

export interface CompactionCounts {
  readonly runs: number;
  readonly events: number;
}

/** One batch: up to `limit` runs, in the team's transaction; `record` audits it (last write). */
export async function compactBatchInTx(
  tx: KobeTx,
  teamId: string,
  limit: number,
  record: (tx: KobeTx, counts: CompactionCounts) => Promise<void>,
): Promise<CompactionCounts & { readonly more: boolean }> {
  // Before the hold lock: a pending hold approval must not make a purge wait without bound.
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
  await lockLegalHolds(tx);
  const res = await tx.execute<{ runs: string; events: string; picked: string }>(sql`
    WITH c AS (
      SELECT r.id FROM runs r
        JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
       WHERE r.team_id = ${teamId} AND t.team_id = ${teamId}
         AND r.ended_at IS NOT NULL AND r.events_compacted_at IS NULL
         AND r.ended_at < now() - make_interval(days => ${COMPACTION_DAYS})
         AND NOT public.legal_hold_covers(t.team_id, t.owner_user_id)
       ORDER BY r.ended_at
       LIMIT ${limit}
       FOR UPDATE OF r SKIP LOCKED
    ), gone AS (
      DELETE FROM run_events e USING c
       WHERE e.team_id = ${teamId} AND e.run_id = c.id
      RETURNING 1
    ), marked AS (
      UPDATE runs r SET events_compacted_at = now() FROM c
       WHERE r.team_id = ${teamId} AND r.id = c.id
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM marked) AS runs, (SELECT count(*) FROM gone) AS events,
           (SELECT count(*) FROM c) AS picked`);
  const row = res.rows[0];
  const counts = { runs: Number(row?.runs ?? 0), events: Number(row?.events ?? 0) };
  if (counts.runs > 0) {
    await auditTimeout(tx);
    await record(tx, counts);
  }
  return { ...counts, more: Number(row?.picked ?? 0) >= limit };
}

/** Compacts the team's due runs batch by batch (each its own transaction) until none is left. */
export async function compactRunEvents(
  db: KobeDb,
  teamId: string,
  record: (tx: KobeTx, counts: CompactionCounts) => Promise<void>,
  options: {
    readonly limit?: number;
    readonly maxBatches?: number;
    readonly stop?: () => boolean;
  } = {},
): Promise<CompactionCounts> {
  const limit = options.limit ?? 200;
  let total = { runs: 0, events: 0 };
  for (let batch = 0; batch < (options.maxBatches ?? 1000); batch++) {
    if (options.stop?.()) break;
    const result = await withTeam(db, teamId, (tx) => compactBatchInTx(tx, teamId, limit, record));
    total = { runs: total.runs + result.runs, events: total.events + result.events };
    if (!result.more) break;
  }
  return total;
}

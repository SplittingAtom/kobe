import {
  BLOB_REF_COLUMNS,
  isLegalHoldViolation,
  lockLegalHolds,
  sql,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { TRASH_RETENTION_DAYS } from "./periods.js";

/**
 * Hard purge of threads (spec D18, KOBE-18): everything a thread owns goes with it — entries, runs,
 * run events, approvals and other thread-scoped rows by `ON DELETE CASCADE`, and the object-store
 * keys of thread-owned blob columns (`BLOB_REF_COLUMNS` with `thread: true`) are queued in
 * `retention_blob_deletions` in the same transaction (deleted from S3 later by `blobs.ts`).
 *
 * Each batch is one short team transaction that follows the KOBE-17 contract:
 *  1. `lockLegalHolds(tx)` first (an approval waits for it; later purges see the hold);
 *  2. held threads are never selected (`legal_hold_covers`); the delete guards back that up;
 *  3. a KH001 from the database means "held": the batch rolls back and the caller skips;
 *  4. the audit event is the transaction's last write.
 * Threads with a queued or active run are skipped (the next pass retries), and rows another
 * transaction holds are skipped (`SKIP LOCKED`), so a purge never waits on a live conversation.
 */

/** Which threads a batch purges. */
export type PurgeSelection =
  /** In Trash for more than 30 days (D18 soft delete), or asked to be deleted for good. */
  | { readonly kind: "trash" }
  /** No activity for `days` (the team's effective retention period). */
  | { readonly kind: "retention"; readonly days: number }
  /** Every thread a user owns in the team (offboarding, KOBE-28). */
  | { readonly kind: "user"; readonly userId: string }
  /** One thread of the owner's Trash ("Delete forever"). */
  | { readonly kind: "thread"; readonly threadId: string; readonly ownerUserId: string };

export interface PurgeCounts {
  readonly threads: number;
  readonly entries: number;
  readonly runs: number;
  readonly events: number;
  /** Object-store keys queued for deletion. */
  readonly blobs: number;
}

export const NO_PURGE: PurgeCounts = { threads: 0, entries: 0, runs: 0, events: 0, blobs: 0 };

export interface BatchLimits {
  /** Threads per batch. */
  readonly threads: number;
  /** Entries per batch (one large thread still goes alone). */
  readonly entries: number;
}

export const DEFAULT_BATCH: BatchLimits = { threads: 50, entries: 20_000 };

/** How long a purge waits for a row lock before giving up on the batch (55P03). */
const LOCK_TIMEOUT = "5s";

const PENDING_RUN_STATUSES = sql.raw(`'queued', 'running', 'waiting_approval'`);
const TRASH_INTERVAL = sql.raw(`interval '${TRASH_RETENTION_DAYS} days'`);

function predicate(selection: PurgeSelection) {
  switch (selection.kind) {
    case "trash":
      return sql`t.deleted_at IS NOT NULL AND t.deleted_at <= now() - ${TRASH_INTERVAL}`;
    case "retention":
      return sql`t.last_activity_at < now() - make_interval(days => ${selection.days})`;
    case "user":
      return sql`t.owner_user_id = ${selection.userId}`;
    case "thread":
      return sql`t.id = ${selection.threadId} AND t.owner_user_id = ${selection.ownerUserId}
        AND t.deleted_at IS NOT NULL`;
  }
}

function order(selection: PurgeSelection) {
  switch (selection.kind) {
    case "trash":
      return sql`t.deleted_at`;
    case "retention":
      return sql`t.last_activity_at`;
    default:
      return sql`t.id`;
  }
}

/** `ARRAY[$1, $2, …]::uuid[]` (ids read from the database). */
export function uuidArray(ids: readonly string[]) {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}

type Candidate = {
  readonly id: string;
  readonly owner_user_id: string;
  readonly last_entry_seq: number;
};

/** Candidates under the batch limits: the first always, then while the entry budget lasts. */
function withinBudget(rows: readonly Candidate[], limits: BatchLimits): Candidate[] {
  const picked: Candidate[] = [];
  let entries = 0;
  for (const row of rows) {
    if (picked.length > 0 && entries + row.last_entry_seq > limits.entries) break;
    picked.push(row);
    entries += row.last_entry_seq;
  }
  return picked;
}

const num = (value: unknown): number => Number(value ?? 0);

/** Queues the object keys of the threads' thread-owned blob columns; returns how many were new. */
async function queueBlobs(tx: KobeTx, teamId: string, ids: readonly string[]): Promise<number> {
  let queued = 0;
  for (const ref of BLOB_REF_COLUMNS.filter((r) => r.thread)) {
    const table = sql.identifier(ref.table);
    const column = sql.identifier(ref.column);
    const res = await tx.execute(sql`
      INSERT INTO retention_blob_deletions (team_id, key, thread_id, owner_user_id)
      SELECT DISTINCT ON (x.${column}) x.team_id, x.${column}, t.id, t.owner_user_id
        FROM ${table} x
        JOIN threads t ON t.team_id = x.team_id AND t.id = x.thread_id
       WHERE x.team_id = ${teamId} AND t.team_id = ${teamId}
         AND x.thread_id = ANY(${uuidArray(ids)}) AND x.${column} IS NOT NULL
      ON CONFLICT (team_id, key) DO NOTHING`);
    queued += res.rowCount ?? 0;
  }
  return queued;
}

/** What deleting the threads takes with it (for the audit event; counts only). */
async function countOwned(tx: KobeTx, teamId: string, ids: readonly string[]) {
  const res = await tx.execute<{ entries: string; runs: string; events: string }>(sql`
    SELECT
      (SELECT count(*) FROM thread_entries e
        WHERE e.team_id = ${teamId} AND e.thread_id = ANY(${uuidArray(ids)})) AS entries,
      (SELECT count(*) FROM runs r
        WHERE r.team_id = ${teamId} AND r.thread_id = ANY(${uuidArray(ids)})) AS runs,
      (SELECT count(*) FROM run_events v
         JOIN runs r ON r.team_id = v.team_id AND r.id = v.run_id
        WHERE v.team_id = ${teamId} AND r.team_id = ${teamId}
          AND r.thread_id = ANY(${uuidArray(ids)})) AS events`);
  const row = res.rows[0];
  return { entries: num(row?.entries), runs: num(row?.runs), events: num(row?.events) };
}

export interface PurgeBatchResult extends PurgeCounts {
  /** The threads purged (ids). */
  readonly threadIds: readonly string[];
  /** More candidates may remain (the batch was full). */
  readonly more: boolean;
}

/**
 * One purge batch in the team's transaction. `record` writes the audit event (last write) when
 * something was purged. Throws on database errors; `isLegalHoldViolation(err)` means held.
 */
export async function purgeBatchInTx(
  tx: KobeTx,
  teamId: string,
  selection: PurgeSelection,
  limits: BatchLimits,
  record: (tx: KobeTx, counts: PurgeBatchResult) => Promise<void>,
): Promise<PurgeBatchResult> {
  // Before the hold lock: a pending hold approval must not make a purge wait without bound.
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`));
  await lockLegalHolds(tx);
  const found = await tx.execute<Candidate>(sql`
    SELECT t.id, t.owner_user_id, t.last_entry_seq FROM threads t
     WHERE t.team_id = ${teamId} AND ${predicate(selection)}
       AND NOT public.legal_hold_covers(t.team_id, t.owner_user_id)
       AND NOT EXISTS (
         SELECT 1 FROM runs r
          WHERE r.team_id = t.team_id AND r.thread_id = t.id
            AND r.status IN (${PENDING_RUN_STATUSES}))
     ORDER BY ${order(selection)}
     LIMIT ${limits.threads}
     FOR UPDATE OF t SKIP LOCKED`);
  const picked = withinBudget(found.rows, limits);
  const more = found.rows.length >= limits.threads || picked.length < found.rows.length;
  if (picked.length === 0) return { ...NO_PURGE, threadIds: [], more: false };
  const ids = picked.map((r) => r.id);
  const owned = await countOwned(tx, teamId, ids);
  const blobs = await queueBlobs(tx, teamId, ids);
  // Cascades to entries, runs, run events, approvals and the wire's thread rows (all keyed on
  // (team_id, thread_id), so a cascade can never reach another team).
  await tx.execute(sql`
    DELETE FROM threads WHERE team_id = ${teamId} AND id = ANY(${uuidArray(ids)})`);
  const result: PurgeBatchResult = {
    threads: ids.length,
    ...owned,
    blobs,
    threadIds: ids,
    more,
  };
  await record(tx, result);
  return result;
}

export type PurgeOutcome =
  | { readonly status: "done"; readonly counts: PurgeCounts }
  /** A legal hold refused a delete (KH001): nothing more was purged for this selection. */
  | { readonly status: "held"; readonly counts: PurgeCounts }
  /** The time or batch budget ran out; the next pass continues. */
  | { readonly status: "budget"; readonly counts: PurgeCounts };

export interface PurgeLoopOptions {
  readonly limits?: BatchLimits;
  /** Batches before stopping (the next pass continues). */
  readonly maxBatches?: number;
  /** Stop starting batches after this instant (ms epoch). */
  readonly deadline?: number;
}

function add(a: PurgeCounts, b: PurgeCounts): PurgeCounts {
  return {
    threads: a.threads + b.threads,
    entries: a.entries + b.entries,
    runs: a.runs + b.runs,
    events: a.events + b.events,
    blobs: a.blobs + b.blobs,
  };
}

/**
 * Purges every thread `selection` matches in the team, batch by batch (each its own transaction),
 * until none is left, a hold refuses a delete, or the budget runs out.
 */
export async function purgeThreads(
  db: KobeDb,
  teamId: string,
  selection: PurgeSelection,
  record: (tx: KobeTx, counts: PurgeBatchResult) => Promise<void>,
  options: PurgeLoopOptions = {},
): Promise<PurgeOutcome> {
  const limits = options.limits ?? DEFAULT_BATCH;
  const maxBatches = options.maxBatches ?? 1000;
  let counts = NO_PURGE;
  for (let batch = 0; batch < maxBatches; batch++) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      return { status: "budget", counts };
    }
    let result: PurgeBatchResult;
    try {
      result = await withTeam(db, teamId, (tx) =>
        purgeBatchInTx(tx, teamId, selection, limits, record),
      );
    } catch (err) {
      if (isLegalHoldViolation(err)) return { status: "held", counts };
      throw err;
    }
    counts = add(counts, result);
    if (!result.more) return { status: "done", counts };
  }
  return { status: "budget", counts };
}

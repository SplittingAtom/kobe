import { auditTimeout } from "./locks.js";
import {
  BLOB_REF_COLUMNS,
  lockLegalHolds,
  sql,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { logger } from "../logger.js";
import type { ObjectStore } from "../workspace-sync/object-store.js";

/**
 * Deletes the object-store keys purges released (`retention_blob_deletions`, KOBE-18) — the bytes
 * of purged entries, uploads and artifacts. A key is deleted only when, in one team transaction
 * that holds the legal-hold lock:
 *  - no legal hold covers the purged thread's owner (a hold placed after the rows went still
 *    keeps the bytes);
 *  - no registered blob column (`BLOB_REF_COLUMNS`) of the team references it any more (shared
 *    and deduplicated objects, e.g. an upload also copied into a workspace, survive);
 *  - it lies in the purged thread's own tree (`<prefix>teams/<team>/threads/<thread>/`,
 *    `threadKey`); anything else (another thread's, a member's or a workspace's objects) is never
 *    deleted here.
 * Rows enqueued with a future `enqueued_at` are not due yet: artifact uploads (KOBE-129) are
 * queued that way before their bytes are written and cleared when their rows commit, so a
 * crash in between leaves a leftover this pass deletes once it is due, while an upload in
 * flight is never deleted under the writer.
 * Keys failing the last check are dropped from the queue without touching the bucket. The object
 * delete runs inside the transaction, so an approval of a hold waits for it (bounded: one batch).
 */

export interface BlobStore {
  readonly objects: ObjectStore;
  /** The configured key prefix (`s3.prefix`), e.g. `kobe/` or ``. */
  readonly prefix: string;
}

export interface BlobDeletionCounts {
  /** Objects deleted from the bucket. */
  readonly blobs: number;
  /** Queue entries dropped without deleting (still referenced, or outside the team's keys). */
  readonly kept: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether `key` lies in the thread's own object tree, `<prefix>teams/<team>/threads/<thread>/…`
 * (no empty or dot segments). Thread-owned objects (offloaded entries, uploads, artifacts) live
 * there; export reads and retention deletes nothing else for a thread, so a crafted reference
 * can't reach another thread's, member's or team's objects, nor a workspace store.
 */
export function threadKey(prefix: string, teamId: string, threadId: string, key: string): boolean {
  if (!UUID.test(teamId) || !UUID.test(threadId)) return false;
  const tree = `${prefix}teams/${teamId}/threads/${threadId}/`;
  if (!key.startsWith(tree)) return false;
  return !key
    .slice(tree.length)
    .split("/")
    .some((p) => p === "" || p === "." || p === "..");
}

/** Longest one batch's object delete may take while the hold lock is held. */
const DELETE_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`object store delete timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Keys among `keys` that a thread-owned column of the team still references (another thread). */
async function stillReferenced(
  tx: KobeTx,
  teamId: string,
  keys: readonly string[],
): Promise<Set<string>> {
  const referenced = new Set<string>();
  const list = sql`ARRAY[${sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  )}]::text[]`;
  // Only thread-owned columns can hold keys in a thread's tree (the only keys deleted here); they
  // are indexed on (team_id, column). Workspace keys never live under `…/threads/<thread>/`.
  for (const ref of BLOB_REF_COLUMNS.filter((r) => r.thread)) {
    const column = sql.identifier(ref.column);
    const res = await tx.execute<{ key: string }>(sql`
      SELECT DISTINCT x.${column} AS key FROM ${sql.identifier(ref.table)} x
       WHERE x.team_id = ${teamId} AND x.${column} = ANY(${list})`);
    for (const row of res.rows) referenced.add(row.key);
  }
  return referenced;
}

/** One batch in the team's transaction; `record` audits it (last write). */
export async function deleteBlobBatchInTx(
  tx: KobeTx,
  teamId: string,
  store: BlobStore,
  limit: number,
  record: (tx: KobeTx, counts: BlobDeletionCounts) => Promise<void>,
): Promise<BlobDeletionCounts & { readonly more: boolean }> {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
  await lockLegalHolds(tx);
  const queued = await tx.execute<{ key: string; thread_id: string }>(sql`
    SELECT q.key, q.thread_id FROM retention_blob_deletions q
     WHERE q.team_id = ${teamId}
       AND q.enqueued_at <= now()
       AND NOT public.legal_hold_covers(q.team_id, q.owner_user_id)
     ORDER BY q.enqueued_at, q.key
     LIMIT ${limit}
     FOR UPDATE SKIP LOCKED`);
  const keys = queued.rows.map((r) => r.key);
  if (keys.length === 0) return { blobs: 0, kept: 0, more: false };
  const referenced = await stillReferenced(tx, teamId, keys);
  const doomed = queued.rows
    .filter((r) => !referenced.has(r.key) && threadKey(store.prefix, teamId, r.thread_id, r.key))
    .map((r) => r.key);
  // Bounded: the transaction holds the legal-hold lock shared, and an approval waits for it.
  if (doomed.length > 0) await withTimeout(store.objects.delete(doomed), DELETE_TIMEOUT_MS);
  await tx.execute(sql`
    DELETE FROM retention_blob_deletions
     WHERE team_id = ${teamId} AND key = ANY(ARRAY[${sql.join(
       keys.map((k) => sql`${k}`),
       sql`, `,
     )}]::text[])`);
  const counts = { blobs: doomed.length, kept: keys.length - doomed.length };
  await auditTimeout(tx);
  await record(tx, counts);
  return { ...counts, more: keys.length >= limit };
}

/** Counts a failed attempt on the oldest queued keys (the object store was unreachable). */
async function noteFailure(db: KobeDb, teamId: string, limit: number): Promise<void> {
  await withTeam(db, teamId, (tx) =>
    tx.execute(sql`
      UPDATE retention_blob_deletions SET attempts = attempts + 1
       WHERE (team_id, key) IN (
         SELECT team_id, key FROM retention_blob_deletions
          WHERE team_id = ${teamId} ORDER BY enqueued_at, key LIMIT ${limit})`),
  );
}

/**
 * Drains the team's queue batch by batch. An object-store failure stops this team for this pass
 * (counted in `attempts`; the queue is kept and the next pass retries) and is rethrown.
 */
export async function deleteReleasedBlobs(
  db: KobeDb,
  teamId: string,
  store: BlobStore,
  record: (tx: KobeTx, counts: BlobDeletionCounts) => Promise<void>,
  options: {
    readonly limit?: number;
    readonly maxBatches?: number;
    readonly stop?: () => boolean;
  } = {},
): Promise<BlobDeletionCounts> {
  const limit = options.limit ?? 100;
  let total = { blobs: 0, kept: 0 };
  for (let batch = 0; batch < (options.maxBatches ?? 1000); batch++) {
    if (options.stop?.()) break;
    let result: BlobDeletionCounts & { more: boolean };
    try {
      result = await withTeam(db, teamId, (tx) =>
        deleteBlobBatchInTx(tx, teamId, store, limit, record),
      );
    } catch (err) {
      await noteFailure(db, teamId, limit).catch((noteErr: unknown) =>
        logger.warn({ err: noteErr, teamId }, "could not count a failed blob deletion"),
      );
      throw err;
    }
    total = { blobs: total.blobs + result.blobs, kept: total.kept + result.kept };
    if (!result.more) break;
  }
  return total;
}

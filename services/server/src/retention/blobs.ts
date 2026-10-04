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
 *  - it lies in the team's own key space (`<prefix>teams/<team>/`), outside the workspaces'
 *    content-addressed stores (`…/users/<user>/workspace/`, collected by workspace sync, KOBE-27)
 *    and, under `…/users/<user>/`, only in the purged thread owner's own keys.
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

/**
 * Whether `key` is one of `userId`'s objects in `teamId`'s key space: under `<prefix>teams/<team>/`,
 * no empty or dot segments, and under `users/<user>/` only that user's own keys. Export reads only
 * such keys; deletion additionally spares workspace stores (`deletableKey`).
 */
export function ownedKey(prefix: string, teamId: string, userId: string, key: string): boolean {
  const teamPrefix = `${prefix}teams/${teamId}/`;
  if (!key.startsWith(teamPrefix)) return false;
  const parts = key.slice(teamPrefix.length).split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  return parts[0] !== "users" || parts[1] === userId;
}

/** Whether the retention job may delete `key`, released by a thread `ownerUserId` owned. */
export function deletableKey(
  prefix: string,
  teamId: string,
  ownerUserId: string,
  key: string,
): boolean {
  if (!ownedKey(prefix, teamId, ownerUserId, key)) return false;
  const parts = key.slice(`${prefix}teams/${teamId}/`.length).split("/");
  return !(parts[0] === "users" && parts[2] === "workspace");
}

/** Keys among `keys` that a registered column of the team still references. */
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
  for (const ref of BLOB_REF_COLUMNS) {
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
  await lockLegalHolds(tx);
  const queued = await tx.execute<{ key: string; owner_user_id: string }>(sql`
    SELECT q.key, q.owner_user_id FROM retention_blob_deletions q
     WHERE q.team_id = ${teamId}
       AND NOT public.legal_hold_covers(q.team_id, q.owner_user_id)
     ORDER BY q.enqueued_at, q.key
     LIMIT ${limit}
     FOR UPDATE SKIP LOCKED`);
  const keys = queued.rows.map((r) => r.key);
  if (keys.length === 0) return { blobs: 0, kept: 0, more: false };
  const referenced = await stillReferenced(tx, teamId, keys);
  const doomed = queued.rows
    .filter(
      (r) => !referenced.has(r.key) && deletableKey(store.prefix, teamId, r.owner_user_id, r.key),
    )
    .map((r) => r.key);
  if (doomed.length > 0) await store.objects.delete(doomed);
  await tx.execute(sql`
    DELETE FROM retention_blob_deletions
     WHERE team_id = ${teamId} AND key = ANY(ARRAY[${sql.join(
       keys.map((k) => sql`${k}`),
       sql`, `,
     )}]::text[])`);
  const counts = { blobs: doomed.length, kept: keys.length - doomed.length };
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
    readonly deadline?: number;
  } = {},
): Promise<BlobDeletionCounts> {
  const limit = options.limit ?? 100;
  let total = { blobs: 0, kept: 0 };
  for (let batch = 0; batch < (options.maxBatches ?? 1000); batch++) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) break;
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

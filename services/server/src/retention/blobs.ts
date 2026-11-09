import { deleteBounded } from "./bounded-delete.js";
import { withTeamRecovering } from "./recovering.js";
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
 * Project objects (KOBE-579, GV3) use the same queue: `thread_id` then carries the project id and
 * the key must lie in that project's own tree (`<prefix>teams/<team>/projects/<project>/`); such a
 * key goes only while no legal hold covers the team at all (project history's rule) and no
 * project tree, head file or workspace row still names it (members' mounts and working copies
 * point at project objects).
 * Keys failing the last check are dropped from the queue without touching the bucket. The object
 * delete runs inside the transaction, so an approval of a hold waits for it (bounded: one batch).
 */

export interface BlobStore {
  readonly objects: ObjectStore;
  /** The configured key prefix (`s3.prefix`), e.g. `kobe/` or ``. */
  readonly prefix: string;
  /** Test hook: how long a batch delete may run before it is aborted (default 30 s). */
  readonly deleteTimeoutMs?: number;
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

/** Whether `key` lies in the project's own object tree (`projects/tree.ts isProjectKey`). */
export function projectTreeKey(
  prefix: string,
  teamId: string,
  projectId: string,
  key: string,
): boolean {
  if (!UUID.test(teamId) || !UUID.test(projectId)) return false;
  const tree = `${prefix}teams/${teamId}/projects/${projectId}/`;
  if (!key.startsWith(tree)) return false;
  return !key
    .slice(tree.length)
    .split("/")
    .some((p) => p === "" || p === "." || p === "..");
}

/** Project keys among `keys` that a project tree, head file or workspace row still names. */
async function projectReferenced(
  tx: KobeTx,
  teamId: string,
  keys: readonly string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const list = sql`ARRAY[${sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  )}]::text[]`;
  const res = await tx.execute<{ key: string }>(sql`
    SELECT blob_ref AS key FROM project_tree_entries WHERE team_id = ${teamId} AND blob_ref = ANY(${list})
    UNION SELECT blob_ref FROM project_files WHERE team_id = ${teamId} AND blob_ref = ANY(${list})
    UNION SELECT blob_key FROM workspace_files
           WHERE team_id = ${teamId} AND NOT deleted AND blob_key = ANY(${list})
    UNION SELECT blob_key FROM workspace_file_hold_history
           WHERE team_id = ${teamId} AND blob_key = ANY(${list})`);
  return new Set(res.rows.map((r) => r.key));
}

/** Keys among `keys` that a thread-owned column of the team still references (another thread). */
async function stillReferenced(
  tx: KobeTx,
  teamId: string,
  keys: readonly string[],
): Promise<Set<string>> {
  const referenced = new Set<string>();
  if (keys.length === 0) return referenced;
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
  const projectRoot = `${store.prefix}teams/${teamId}/projects/`;
  const queued = await tx.execute<{ key: string; thread_id: string }>(sql`
    SELECT q.key, q.thread_id FROM retention_blob_deletions q
     WHERE q.team_id = ${teamId}
       AND q.enqueued_at <= now()
       AND NOT public.legal_hold_covers(q.team_id, q.owner_user_id)
       AND (NOT starts_with(q.key, ${projectRoot})
            OR NOT public.memory_legal_hold_covers(q.team_id, NULL))
     ORDER BY q.enqueued_at, q.key
     LIMIT ${limit}
     FOR UPDATE SKIP LOCKED`);
  const keys = queued.rows.map((r) => r.key);
  if (keys.length === 0) return { blobs: 0, kept: 0, more: false };
  const projectRows = queued.rows.filter((r) =>
    projectTreeKey(store.prefix, teamId, r.thread_id, r.key),
  );
  const threadRows = queued.rows.filter((r) => !projectRows.includes(r));
  const referenced = await stillReferenced(
    tx,
    teamId,
    threadRows.map((r) => r.key),
  );
  const projectHeld = await projectReferenced(
    tx,
    teamId,
    projectRows.map((r) => r.key),
  );
  const doomed = [
    ...threadRows
      .filter((r) => !referenced.has(r.key) && threadKey(store.prefix, teamId, r.thread_id, r.key))
      .map((r) => r.key),
    ...projectRows.filter((r) => !projectHeld.has(r.key)).map((r) => r.key),
  ];
  // Bounded and abortable: the transaction holds the legal-hold lock shared, and an approval
  // waits for it; on timeout the delete is aborted and settled before the lock is released.
  if (doomed.length > 0)
    await deleteBounded(
      store.objects,
      doomed,
      store.deleteTimeoutMs,
      undefined,
      (gone) => async (t) => {
        await t.execute(sql`
        DELETE FROM retention_blob_deletions
         WHERE team_id = ${teamId} AND key = ANY(ARRAY[${sql.join(
           gone.map((k) => sql`${k}`),
           sql`, `,
         )}]::text[])
           AND NOT public.legal_hold_covers(team_id, owner_user_id)`);
      },
    );
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
      result = await withTeamRecovering(db, teamId, (tx) =>
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

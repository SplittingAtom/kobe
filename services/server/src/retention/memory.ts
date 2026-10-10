import { SYSTEM_ACTOR, lockLegalHolds, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { memoryBlobKey } from "../memory/keys.js";
import { auditTimeout } from "./locks.js";
import { withTimeout, type BlobStore } from "./blobs.js";

/**
 * Memory retention (spec D24 "memory follows team retention", user decision 2026-10-09, KOBE-188).
 * A live file is never purged. After the team's effective window (none when forever):
 *  - `versions`: versions superseded longer ago than the window (the Undo history); the current
 *    version stays;
 *  - `docs`: files soft-deleted longer ago than the window, with every version.
 * Offboarding (`user`): all of a departed member's personal files, deleted or not. Project memory
 * follows the project, never a member.
 * Each batch runs in one team transaction that takes the legal-hold lock first and skips owners
 * covered by a hold (`memory_legal_hold_covers`: a project file is covered by any active hold in
 * its team); the object delete happens inside it, so a hold approved meanwhile waits and a hold
 * placed earlier wins. Audit: counts only.
 */

export type MemorySelection =
  | { readonly kind: "versions"; readonly cutoff: Date }
  | { readonly kind: "docs"; readonly cutoff: Date }
  | { readonly kind: "user"; readonly userId: string };

export interface MemoryPurgeCounts {
  readonly docs: number;
  readonly versions: number;
  /** Objects deleted from the bucket. */
  readonly blobs: number;
}

export const NO_MEMORY_PURGE: MemoryPurgeCounts = { docs: 0, versions: 0, blobs: 0 };

const BATCH_DOCS = 50;
const BATCH_VERSIONS = 200;
const DELETE_TIMEOUT_MS = 30_000;

interface Doomed {
  readonly docId: string;
  readonly version: number;
  readonly blobRef: string;
}

const keyList = (keys: readonly string[]) =>
  sql`ARRAY[${sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  )}]::text[]`;

/** Deletes the objects that lie where the store put them (never a key we would not derive). */
async function deleteObjects(
  store: BlobStore,
  teamId: string,
  rows: readonly Doomed[],
): Promise<number> {
  const keys = rows
    .filter((r) => r.blobRef === memoryBlobKey(store.prefix, teamId, r.docId, r.version))
    .map((r) => r.blobRef);
  // Bounded: the transaction holds the legal-hold lock shared, and an approval waits for it.
  if (keys.length > 0) await withTimeout(store.objects.delete(keys), DELETE_TIMEOUT_MS);
  return keys.length;
}

async function versionBatch(
  tx: KobeTx,
  teamId: string,
  store: BlobStore,
  cutoff: Date,
): Promise<MemoryPurgeCounts> {
  const found = await tx.execute<{ doc_id: string; version: number; blob_ref: string }>(sql`
    SELECT v.doc_id, v.version, v.blob_ref
      FROM memory_doc_versions v
      JOIN memory_docs d ON d.team_id = v.team_id AND d.id = v.doc_id
     WHERE v.team_id = ${teamId}
       AND v.version < d.current_version
       AND NOT public.memory_legal_hold_covers(d.team_id, d.owner_user_id)
       AND (SELECT min(n.created_at) FROM memory_doc_versions n
             WHERE n.team_id = v.team_id AND n.doc_id = v.doc_id AND n.version > v.version
           ) < ${cutoff}
     ORDER BY v.created_at, v.doc_id, v.version
     LIMIT ${BATCH_VERSIONS}
       FOR UPDATE OF v SKIP LOCKED`);
  if (found.rows.length === 0) return NO_MEMORY_PURGE;
  const rows = found.rows.map((r) => ({
    docId: r.doc_id,
    version: r.version,
    blobRef: r.blob_ref,
  }));
  const blobs = await deleteObjects(store, teamId, rows);
  for (const r of rows) {
    await tx.execute(sql`
      DELETE FROM memory_doc_versions
       WHERE team_id = ${teamId} AND doc_id = ${r.docId} AND version = ${r.version}`);
  }
  return { docs: 0, versions: rows.length, blobs };
}

async function docBatch(
  tx: KobeTx,
  teamId: string,
  store: BlobStore,
  selection: Exclude<MemorySelection, { kind: "versions" }>,
): Promise<MemoryPurgeCounts> {
  const which =
    selection.kind === "docs"
      ? sql`d.deleted_at IS NOT NULL AND d.deleted_at < ${selection.cutoff}`
      : sql`d.scope = 'user' AND d.owner_user_id = ${selection.userId}`;
  const docs = await tx.execute<{ id: string }>(sql`
    SELECT d.id FROM memory_docs d
     WHERE d.team_id = ${teamId} AND ${which}
       AND NOT public.memory_legal_hold_covers(d.team_id, d.owner_user_id)
     ORDER BY d.id
     LIMIT ${BATCH_DOCS}
       FOR UPDATE OF d SKIP LOCKED`);
  const ids = docs.rows.map((r) => r.id);
  if (ids.length === 0) return NO_MEMORY_PURGE;
  const versions = await tx.execute<{ doc_id: string; version: number; blob_ref: string }>(sql`
    SELECT doc_id, version, blob_ref FROM memory_doc_versions
     WHERE team_id = ${teamId} AND doc_id = ANY(${keyList(ids)}::uuid[])`);
  const rows = versions.rows.map((r) => ({
    docId: r.doc_id,
    version: r.version,
    blobRef: r.blob_ref,
  }));
  const blobs = await deleteObjects(store, teamId, rows);
  // The versions go with their file (ON DELETE CASCADE).
  await tx.execute(sql`
    DELETE FROM memory_docs WHERE team_id = ${teamId} AND id = ANY(${keyList(ids)}::uuid[])`);
  return { docs: ids.length, versions: rows.length, blobs };
}

/**
 * One batch inside the caller's team transaction (the offboarding sweep calls it after its own
 * hold check). Takes the legal-hold lock itself; `record` audits the batch when it removed
 * something (last write).
 */
export async function purgeMemoryBatchInTx(
  tx: KobeTx,
  teamId: string,
  store: BlobStore,
  selection: MemorySelection,
  record: (tx: KobeTx, counts: MemoryPurgeCounts) => Promise<void>,
): Promise<MemoryPurgeCounts> {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
  await lockLegalHolds(tx);
  const counts =
    selection.kind === "versions"
      ? await versionBatch(tx, teamId, store, selection.cutoff)
      : await docBatch(tx, teamId, store, selection);
  if (counts.docs + counts.versions > 0) {
    await auditTimeout(tx);
    await record(tx, counts);
  }
  return counts;
}

/** The `retention.memory_purged` audit writer (counts only). */
export function memoryRecorder(
  teamId: string,
  reason: "retention" | "offboarding",
  userId?: string,
) {
  return async (tx: KobeTx, counts: MemoryPurgeCounts): Promise<void> => {
    await recordAudit(tx, {
      action: "retention.memory_purged",
      actor: SYSTEM_ACTOR,
      teamId,
      target: {
        reason,
        docs: counts.docs,
        versions: counts.versions,
        blobs: counts.blobs,
        ...(userId ? { userId } : {}),
      },
    });
  };
}

/** Runs batches until nothing is left to purge (or `stop`); object-store errors propagate. */
export async function purgeMemory(
  db: KobeDb,
  teamId: string,
  store: BlobStore,
  selection: MemorySelection,
  options: { readonly stop?: () => boolean; readonly maxBatches?: number } = {},
): Promise<MemoryPurgeCounts> {
  const reason = selection.kind === "user" ? "offboarding" : "retention";
  const record = memoryRecorder(
    teamId,
    reason,
    selection.kind === "user" ? selection.userId : undefined,
  );
  let total = NO_MEMORY_PURGE;
  for (let batch = 0; batch < (options.maxBatches ?? 1000); batch++) {
    if (options.stop?.()) break;
    const counts = await withTeam(db, teamId, (tx) =>
      purgeMemoryBatchInTx(tx, teamId, store, selection, record),
    );
    if (counts.docs + counts.versions === 0) break;
    total = {
      docs: total.docs + counts.docs,
      versions: total.versions + counts.versions,
      blobs: total.blobs + counts.blobs,
    };
  }
  return total;
}

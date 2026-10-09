import { SYSTEM_ACTOR, lockLegalHolds, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { auditTimeout } from "../retention/locks.js";
import type { BlobStore } from "../retention/blobs.js";

/**
 * Deletes uploads that never joined a thread (`thread_id` null) once they are older than
 * `orphanHours` (KOBE-143): the user abandoned the draft, or the message was never sent. Part of
 * the nightly retention pass (a file lives between the window and the window plus one pass
 * interval). Skips files whose owner is under legal hold (the delete guard would refuse them
 * anyway). The object goes first, inside the transaction that holds the legal-hold lock shared
 * (as `deleteBlobBatchInTx`); a bucket failure aborts the batch and the next pass retries.
 */
export interface ExpiredUploads {
  readonly files: number;
  readonly bytes: number;
}

const BATCH = 100;
const DELETE_TIMEOUT_MS = 30_000;

async function expireBatch(
  tx: KobeTx,
  teamId: string,
  blobs: BlobStore,
  orphanHours: number,
): Promise<ExpiredUploads & { readonly more: boolean }> {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
  await lockLegalHolds(tx);
  const due = await tx.execute<{ id: string; blob_ref: string; size_bytes: string }>(sql`
    SELECT id, blob_ref, size_bytes FROM files
     WHERE team_id = ${teamId} AND kind = 'upload' AND thread_id IS NULL
       AND created_at < now() - make_interval(hours => ${orphanHours})
       AND NOT public.legal_hold_covers(team_id, user_id)
     ORDER BY created_at, id
     LIMIT ${BATCH}
     FOR UPDATE SKIP LOCKED`);
  if (due.rows.length === 0) return { files: 0, bytes: 0, more: false };
  const keys = due.rows.map((r) => r.blob_ref);
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("object store delete timed out")), DELETE_TIMEOUT_MS).unref(),
  );
  await Promise.race([blobs.objects.delete(keys), timer]);
  await tx.execute(sql`
    DELETE FROM files WHERE team_id = ${teamId}
       AND id = ANY(ARRAY[${sql.join(
         due.rows.map((r) => sql`${r.id}`),
         sql`, `,
       )}]::uuid[])`);
  const counts = {
    files: due.rows.length,
    bytes: due.rows.reduce((sum, r) => sum + Number(r.size_bytes), 0),
  };
  await auditTimeout(tx);
  await recordAudit(tx, {
    action: "workspace.uploads_expired",
    actor: SYSTEM_ACTOR,
    teamId,
    target: counts,
  });
  return { ...counts, more: due.rows.length >= BATCH };
}

export async function expireOrphanUploads(
  db: KobeDb,
  teamId: string,
  blobs: BlobStore,
  orphanHours: number,
  options: { readonly stop?: () => boolean; readonly maxBatches?: number } = {},
): Promise<ExpiredUploads> {
  let total = { files: 0, bytes: 0 };
  for (let i = 0; i < (options.maxBatches ?? 1000); i++) {
    if (options.stop?.()) break;
    const r = await withTeam(db, teamId, (tx) => expireBatch(tx, teamId, blobs, orphanHours));
    total = { files: total.files + r.files, bytes: total.bytes + r.bytes };
    if (!r.more) break;
  }
  return total;
}

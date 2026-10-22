import {
  isUnderLegalHold,
  lockLegalHolds,
  sql,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { Logger } from "pino";
import { workspaceBlobKey, type WorkspaceOwner } from "./keys.js";
import type { ObjectStore } from "./object-store.js";
import type { StoredEntry } from "./store.js";

/**
 * Lost content (KOBE-475): a `workspace_blobs` row whose object storage was found without the
 * object (a read got "no such object", or the repair sweep's listing and a confirming read both
 * lacked it) is marked `lost_at`. The mark never comes from a row alone, and only content in the
 * workspace's own prefix is marked (a sandbox can upload only there). The sandbox asks for the
 * list on each push (`GET blobs/lost`) and uploads what it still holds; the upload is verified
 * against the hash and the row's size and clears the mark. Collection and legal holds are
 * unchanged: a lost row is collected like any other once no path references it, and nothing
 * here deletes anything.
 */

/** What a member is told when a file's saved copy is missing (the web words it per file). */
export const CONTENT_MISSING =
  "The saved copy of this file is missing; it will be restored from your sandbox at its next sync.";

/**
 * A `workspace_blobs` row that is lost **and still referenced by a live file**: only those are
 * listed, accepted as resends and treated as absent. Unreferenced lost content behaves like any
 * held blob and collection frees it as usual (no resend can race a collection of it).
 */
export const LIVE_LOST = sql.raw(`(workspace_blobs.lost_at IS NOT NULL AND EXISTS (
  SELECT 1 FROM workspace_files lf
   WHERE lf.team_id = workspace_blobs.team_id AND lf.user_id = workspace_blobs.user_id
     AND lf.sha256 = workspace_blobs.sha256 AND NOT lf.deleted))`);

/** Lost hashes listed to a sandbox at once (the contract's batch). */
export const LOST_LIST_MAX = 1000;

/**
 * Marks the content lost (creating its row when a server write left none). Returns true when
 * this call set the mark. A row being collected is left alone.
 */
export async function markBlobLost(
  tx: KobeTx,
  owner: WorkspaceOwner,
  sha256: string,
  size: number,
): Promise<boolean> {
  const res = await tx.execute<{ inserted: boolean }>(sql`
    INSERT INTO workspace_blobs (team_id, user_id, sha256, size, lost_at)
    VALUES (${owner.teamId}, ${owner.userId}, ${sha256}, ${size}, now())
    ON CONFLICT (team_id, user_id, sha256) DO UPDATE SET lost_at = now()
     WHERE workspace_blobs.lost_at IS NULL AND NOT workspace_blobs.deleting
    RETURNING (xmax = 0) AS inserted`);
  const row = res.rows[0];
  if (!row) return false;
  if (row.inserted) {
    // A new row joins the blob totals like an upload would (collection recomputes them anyway).
    await tx.execute(sql`
      UPDATE workspace_sync SET blob_count = blob_count + 1, blob_bytes = blob_bytes + ${size}
       WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}`);
  }
  return true;
}

/** The workspace's lost hashes (oldest mark first), for `GET blobs/lost`. */
export async function lostBlobs(
  tx: KobeTx,
  owner: WorkspaceOwner,
  limit = LOST_LIST_MAX,
): Promise<string[]> {
  const res = await tx.execute<{ sha256: string }>(sql`
    SELECT sha256 FROM workspace_blobs
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}
       AND ${LIVE_LOST} AND NOT deleting
     ORDER BY lost_at, sha256 LIMIT ${limit}`);
  return res.rows.map((r) => r.sha256);
}

/** The recorded size of lost content, or undefined when it is not lost (or being collected). */
export async function lostBlobSize(
  tx: KobeTx,
  owner: WorkspaceOwner,
  sha256: string,
): Promise<number | undefined> {
  const res = await tx.execute<{ size: string }>(sql`
    SELECT size FROM workspace_blobs
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND sha256 = ${sha256}
       AND ${LIVE_LOST} AND NOT deleting`);
  const row = res.rows[0];
  return row ? Number(row.size) : undefined;
}

/**
 * After the verified bytes of lost content were stored again: clears the mark. `healed`, or
 * `deleting` (collected meanwhile: retry later), or `held` (no longer lost: another upload won).
 */
export async function healBlob(
  tx: KobeTx,
  owner: WorkspaceOwner,
  sha256: string,
  size: number,
): Promise<"healed" | "deleting" | "held" | "gone"> {
  const res = await tx.execute<{ deleting: boolean; healed: boolean }>(sql`
    WITH healed AS (
      UPDATE workspace_blobs SET lost_at = NULL
       WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND sha256 = ${sha256}
         AND size = ${size} AND lost_at IS NOT NULL AND NOT deleting
      RETURNING 1)
    SELECT b.deleting, EXISTS (SELECT 1 FROM healed) AS healed FROM workspace_blobs b
     WHERE b.team_id = ${owner.teamId} AND b.user_id = ${owner.userId} AND b.sha256 = ${sha256}`);
  const row = res.rows[0];
  if (!row) return "gone";
  if (row.healed) return "healed";
  return row.deleting ? "deleting" : "held";
}

/**
 * A reader found no object for a live entry: marks its content lost when it lives in the
 * workspace's own prefix (resendable by the sandbox). Never throws; logs no path or name.
 * Returns whether the content is now listed for the sandbox.
 */
export async function reportMissingContent(
  db: KobeDb,
  owner: WorkspaceOwner,
  entry: Pick<StoredEntry, "sha256" | "size" | "blobKey">,
  prefix: string,
  log: Pick<Logger, "warn" | "error">,
): Promise<boolean> {
  const { sha256, blobKey } = entry;
  const resendable = sha256 !== undefined && blobKey === workspaceBlobKey(prefix, owner, sha256);
  if (!resendable) {
    log.warn({ team_id: owner.teamId }, "workspace content missing outside the workspace prefix");
    return false;
  }
  try {
    const marked = await withTeam(db, owner.teamId, (tx) =>
      markBlobLost(tx, owner, sha256, entry.size),
    );
    if (marked) {
      log.warn(
        { team_id: owner.teamId, user_id: owner.userId },
        "workspace content missing in storage: listed for the sandbox to resend",
      );
    }
    return true;
  } catch (err) {
    log.error({ err, team_id: owner.teamId }, "could not mark workspace content lost");
    return false;
  }
}

/**
 * A resend whose row was collected while its bytes were being stored (`healBlob` said `deleting`
 * or `gone`): the object just written belongs to no row and nobody pays for it. Removed with
 * collection's own protocol so a concurrent upload of the same content is never hurt: the row is
 * claimed `deleting` first (committed: uploads then wait and retry), then the object goes, then
 * the claim. Under a legal hold nothing is deleted: the content is recorded and counted instead.
 */
export async function discardOrphanedResend(
  db: KobeDb,
  objects: ObjectStore,
  owner: WorkspaceOwner,
  prefix: string,
  sha256: string,
  size: number,
): Promise<"discarded" | "kept"> {
  const claim = await withTeam(db, owner.teamId, async (tx) => {
    const ours = await tx.execute(sql`
      INSERT INTO workspace_blobs (team_id, user_id, sha256, size, deleting)
      VALUES (${owner.teamId}, ${owner.userId}, ${sha256}, ${size}, true)
      ON CONFLICT (team_id, user_id, sha256) DO NOTHING
      RETURNING 1`);
    if (ours.rows.length > 0) return "ours" as const;
    const row = await tx.execute<{ deleting: boolean }>(sql`
      SELECT deleting FROM workspace_blobs
       WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND sha256 = ${sha256}`);
    return row.rows[0]?.deleting === true ? ("collecting" as const) : ("recorded" as const);
  });
  // Recorded meanwhile by another upload of this content: its row owns the object now.
  if (claim === "recorded") return "kept";
  return withTeam(db, owner.teamId, async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
    await lockLegalHolds(tx);
    const held = await isUnderLegalHold(tx, owner.teamId, owner.userId);
    if (claim === "collecting") {
      // Collection's row: it is deleting this content (under a hold it unmarks and keeps it).
      if (held) return "kept" as const;
      await objects.delete([workspaceBlobKey(prefix, owner, sha256)]);
      return "discarded" as const;
    }
    if (held) {
      const kept = await tx.execute(sql`
        UPDATE workspace_blobs SET deleting = false, released_at = now()
         WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND sha256 = ${sha256}
           AND deleting
        RETURNING 1`);
      if (kept.rows.length > 0) {
        await tx.execute(sql`
          UPDATE workspace_sync SET blob_count = blob_count + 1, blob_bytes = blob_bytes + ${size}
           WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}`);
      }
      return "kept" as const;
    }
    await objects.delete([workspaceBlobKey(prefix, owner, sha256)]);
    await tx.execute(sql`
      DELETE FROM workspace_blobs
       WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND sha256 = ${sha256}
         AND deleting`);
    return "discarded" as const;
  });
}

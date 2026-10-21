import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import type { Logger } from "pino";
import { workspaceBlobKey, type WorkspaceOwner } from "./keys.js";
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
       AND lost_at IS NOT NULL AND NOT deleting
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
       AND lost_at IS NOT NULL AND NOT deleting`);
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

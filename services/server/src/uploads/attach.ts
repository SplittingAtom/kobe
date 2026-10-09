import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { logger } from "../logger.js";
import { RunError } from "../runs/errors.js";
import { workspaceBlobKey, type WorkspaceOwner } from "../workspace-sync/keys.js";
import { resolveLimits } from "../workspace-sync/quota.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";
import {
  blobState,
  finishUpload,
  lockWorkspace,
  recordBlob,
  reserveUpload,
} from "../workspace-sync/store.js";
import { threadAttachmentPaths } from "./attach-list.js";
import { uploadBlobKey } from "./keys.js";
import { lockTeamStorage, storageLimit, storageUsed } from "./quota.js";
import type { UploadSettings } from "./settings.js";

/**
 * Attaching uploads to a message (KOBE-144), in three steps around the submit transaction:
 *
 * 1. `inspect` (inside a short transaction): the files are the caller's own uploads of this team,
 *    unattached, not in another thread, scanned clean or unscanned, and their sum fits the
 *    per-message limit. Anything else is a 404/409/413.
 * 2. `stage` (object store, no transaction held): a user-tree object is copied into the thread's
 *    tree (`threads/<thread>/uploads/<id>`, so thread purge and retention delete it; queued for
 *    deletion first in case we crash), and the content is copied into the owner's content-addressed
 *    workspace blob, the same bookkeeping as a browser upload (reservation, blob row).
 * 3. `commit` (inside the submit transaction): the `files` rows get thread, run and the new key;
 *    each file is written into the workspace manifest at `uploads/<thread>/<name>` with
 *    `putServerFile`, after the team and workspace quotas. The sandbox pulls it before the run.
 *
 * On any failure the caller `discard`s what `stage` copied; after a commit it `finalize`s (deletes
 * the old user-tree objects). Workspace blobs are content-addressed and collected by workspace sync.
 */
export interface AttachCaller {
  readonly teamId: string;
  readonly userId: string;
}

export interface InspectedFile {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly blobRef: string;
}

export interface StagedFile extends InspectedFile {
  /** The thread-tree key the row will point at. */
  readonly threadKey: string;
  /** Whether `stage` created that object (else it already was the file's key). */
  readonly copied: boolean;
}

export interface AttachmentStager {
  inspect(
    tx: KobeTx,
    caller: AttachCaller,
    threadId: string,
    fileIds: readonly string[],
  ): Promise<InspectedFile[]>;
  stage(
    owner: WorkspaceOwner,
    caller: AttachCaller,
    threadId: string,
    files: readonly InspectedFile[],
  ): Promise<StagedFile[]>;
  commit(
    tx: KobeTx,
    owner: WorkspaceOwner,
    caller: AttachCaller,
    threadId: string,
    runId: string,
    staged: readonly StagedFile[],
  ): Promise<void>;
  /** After a failed submit: delete the objects `stage` copied. */
  discard(staged: readonly StagedFile[]): Promise<void>;
  /** After a committed submit: delete the user-tree objects that were copied into the thread. */
  finalize(staged: readonly StagedFile[]): Promise<void>;
}

type FileRow = {
  id: string;
  user_id: string;
  thread_id: string | null;
  run_id: string | null;
  name: string;
  size_bytes: string | number;
  sha256: string;
  blob_ref: string;
  scan_status: string;
};

export interface AttachmentStagerOptions {
  readonly db: KobeDb;
  readonly sync: WorkspaceSync;
  readonly settings: UploadSettings;
}

const PENDING_GRACE = sql.raw("interval '1 hour'");

export function createAttachmentStager(options: AttachmentStagerOptions): AttachmentStager {
  const { db, sync, settings } = options;
  const { objects, prefix } = sync;

  async function inspect(
    tx: KobeTx,
    caller: AttachCaller,
    threadId: string,
    fileIds: readonly string[],
  ): Promise<InspectedFile[]> {
    if (new Set(fileIds).size !== fileIds.length) throw new RunError("file_not_found");
    const res = await tx.execute<FileRow>(sql`
      SELECT id, user_id, thread_id, run_id, name, size_bytes, sha256, blob_ref, scan_status
        FROM files
       WHERE team_id = ${caller.teamId} AND kind = 'upload'
         AND id IN (${sql.join(
           fileIds.map((id) => sql`${id}`),
           sql`, `,
         )})`);
    const byId = new Map(res.rows.map((r) => [r.id, r]));
    const out: InspectedFile[] = [];
    let total = 0;
    for (const id of fileIds) {
      const row = byId.get(id);
      // Unknown, someone else's, in another thread, or never served: all the same 404.
      if (
        row === undefined ||
        row.user_id !== caller.userId ||
        row.scan_status === "rejected" ||
        (row.thread_id !== null && row.thread_id !== threadId)
      ) {
        throw new RunError("file_not_found");
      }
      if (row.run_id !== null) throw new RunError("file_in_use");
      total += Number(row.size_bytes);
      out.push({
        id,
        name: row.name,
        sizeBytes: Number(row.size_bytes),
        sha256: row.sha256,
        blobRef: row.blob_ref,
      });
    }
    if (total > settings.maxMessageBytes) {
      throw new RunError(
        "message_too_large",
        `The attached files add up to more than ${settings.maxMessageBytes} bytes.`,
      );
    }
    return out;
  }

  async function ensureWorkspaceBlob(owner: WorkspaceOwner, file: InspectedFile): Promise<void> {
    const reserved = await withTeam(db, owner.teamId, async (tx) => {
      const held = await blobState(tx, owner, file.sha256);
      if (held !== "absent") return held;
      return (await reserveUpload(tx, owner, file.sizeBytes, resolveLimits(sync.limits)))
        ? ("reserved" as const)
        : ("over_quota" as const);
    });
    if (reserved === "held") return;
    if (reserved === "deleting") throw new RunError("storage_unavailable");
    if (reserved === "over_quota") throw new RunError("quota_exceeded");
    let finished = false;
    let added = false;
    try {
      await objects.copy(file.blobRef, workspaceBlobKey(prefix, owner, file.sha256));
      const outcome = await withTeam(db, owner.teamId, async (tx) => {
        const recorded = await recordBlob(tx, owner, file.sha256, file.sizeBytes);
        await finishUpload(tx, owner, file.sizeBytes, recorded === "added");
        return recorded;
      });
      finished = true;
      added = outcome === "added";
      if (outcome === "deleting") throw new RunError("storage_unavailable");
    } catch (err) {
      if (err instanceof RunError) throw err;
      logger.error({ err, teamId: owner.teamId }, "attachment: workspace copy failed");
      throw new RunError("storage_unavailable");
    } finally {
      if (!finished) {
        await withTeam(db, owner.teamId, (tx) =>
          finishUpload(tx, owner, file.sizeBytes, added),
        ).catch((err: unknown) => logger.error({ err }, "could not end an upload reservation"));
      }
    }
  }

  async function stage(
    owner: WorkspaceOwner,
    caller: AttachCaller,
    threadId: string,
    files: readonly InspectedFile[],
  ): Promise<StagedFile[]> {
    const staged: StagedFile[] = [];
    try {
      for (const file of files) {
        const threadKey = uploadBlobKey(prefix, caller.teamId, caller.userId, threadId, file.id);
        const copied = file.blobRef !== threadKey;
        if (copied) {
          await withTeam(db, caller.teamId, (tx) =>
            tx.execute(sql`
              INSERT INTO retention_blob_deletions (team_id, key, thread_id, owner_user_id, enqueued_at)
              VALUES (${caller.teamId}, ${threadKey}, ${threadId}, ${caller.userId}, now() + ${PENDING_GRACE})
              ON CONFLICT (team_id, key) DO NOTHING`),
          );
          await objects.copy(file.blobRef, threadKey);
        }
        staged.push({ ...file, threadKey, copied });
        await ensureWorkspaceBlob(owner, file);
      }
      return staged;
    } catch (err) {
      await discard(staged);
      if (err instanceof RunError) throw err;
      logger.error({ err, teamId: caller.teamId }, "attachment: staging failed");
      throw new RunError("storage_unavailable");
    }
  }

  async function commit(
    tx: KobeTx,
    owner: WorkspaceOwner,
    caller: AttachCaller,
    threadId: string,
    runId: string,
    staged: readonly StagedFile[],
  ): Promise<void> {
    // Claim the rows: a concurrent submit with the same file loses here.
    for (const file of staged) {
      const claimed = await tx.execute(sql`
        UPDATE files SET thread_id = ${threadId}, run_id = ${runId}, blob_ref = ${file.threadKey}
         WHERE team_id = ${caller.teamId} AND id = ${file.id} AND user_id = ${caller.userId}
           AND run_id IS NULL AND (thread_id IS NULL OR thread_id = ${threadId})
        RETURNING 1`);
      if (claimed.rows.length === 0) throw new RunError("file_in_use");
      if (file.copied) {
        await tx.execute(
          sql`DELETE FROM retention_blob_deletions WHERE team_id = ${caller.teamId} AND key = ${file.threadKey}`,
        );
      }
    }
    await lockTeamStorage(tx, caller.teamId);
    const added = staged.reduce((sum, f) => sum + f.sizeBytes, 0);
    const limit = await storageLimit(tx, caller.teamId, settings.defaultQuotaBytes);
    if ((await storageUsed(tx, caller.teamId)) + added > limit)
      throw new RunError("quota_exceeded");

    const paths = await threadAttachmentPaths(tx, caller.teamId, threadId);
    let state = await lockWorkspace(tx, owner);
    for (const file of staged) {
      const path = paths.get(file.id);
      if (path === undefined) throw new Error("attachment path missing");
      state = {
        ...state,
        liveFiles: state.liveFiles + 1,
        liveBytes: state.liveBytes + file.sizeBytes,
      };
      const decision = await sync.quota(tx, {
        owner,
        fileBytes: file.sizeBytes,
        liveFiles: state.liveFiles,
        liveBytes: state.liveBytes,
      });
      if (!decision.ok) throw new RunError("quota_exceeded");
      await sync.putServerFile(
        tx,
        owner,
        {
          path,
          sha256: file.sha256,
          size: file.sizeBytes,
          blobKey: workspaceBlobKey(prefix, owner, file.sha256),
        },
        "user",
      );
    }
  }

  async function remove(keys: readonly string[], what: string): Promise<void> {
    if (keys.length === 0) return;
    try {
      await objects.delete(keys);
    } catch (err) {
      logger.warn({ err, count: keys.length }, `attachment: could not delete ${what}`);
    }
  }

  const discard = (staged: readonly StagedFile[]) =>
    remove(
      staged.filter((f) => f.copied).map((f) => f.threadKey),
      "copied objects",
    );
  const finalize = (staged: readonly StagedFile[]) =>
    remove(
      staged.filter((f) => f.copied).map((f) => f.blobRef),
      "user-tree uploads",
    );

  return { inspect, stage, commit, discard, finalize };
}

import { randomUUID } from "node:crypto";
import {
  FILE_SHARE_MAX_BYTES,
  uploadFileNameSchema,
  type FileShareFrame,
  type SharedFile,
} from "@kobe/protocol";
import { files, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { AppendError, appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import { logger } from "../logger.js";
import { threadKey, type BlobStore } from "../retention/blobs.js";
import { lockTeamStorage, storageLimit, storageUsed } from "../uploads/quota.js";
import { resolveMime, SNIFF_BYTES } from "../uploads/mime.js";
import type { UploadScanner } from "../uploads/store.js";
import type { UploadSettings } from "../uploads/settings.js";
import { currentEntry } from "../workspace-sync/store.js";
import { shareBlobKey } from "./keys.js";

/**
 * Stores one `file.share` the connection already verified (capability, lease, an allowed
 * `share_file` call with the same input hash; D-3 of KOBE-55, KOBE-150). Nothing the sandbox says
 * about the file is trusted: the bytes are the workspace manifest's own object for the pushed
 * path, and only when its live row still has the `rev`, `sha256` and size of the push.
 *
 * Order: read-only checks in the database (idempotent replay, run active, manifest match), then a
 * server-side copy of the workspace blob to a key in the **thread's own tree**
 * (`teams/<t>/threads/<th>/shared/<file>`, so retention purge and export cover it and it outlives
 * the volume and later workspace edits), then one transaction under the team's storage lock that
 * checks the quota, inserts the `files` row (kind `shared`), audits and appends `file.shared`.
 * The key is queued in `retention_blob_deletions` (due in an hour) before the copy and cleared in
 * that transaction, so a crash leaves nothing retention cannot delete.
 */

export type ShareRefusal =
  | "run_not_active"
  | "not_allowed"
  | "path_mismatch"
  | "not_synced"
  | "not_found"
  | "too_large"
  | "quota_exceeded"
  | "scan_rejected";

export type ShareResult =
  | { readonly ok: true; readonly file: SharedFile; readonly replay: boolean }
  | {
      readonly ok: false;
      readonly code:
        | "not_allowed"
        | "not_synced"
        | "not_found"
        | "invalid_input"
        | "too_large"
        | "quota_exceeded"
        | "scan_rejected"
        | "storage_failed";
      readonly message: string;
      /** Set when the refusal is audited by the caller. */
      readonly refusal?: ShareRefusal;
    };

export interface FileShareDeps {
  readonly db: KobeDb;
  readonly blobs: BlobStore | undefined;
  readonly settings: UploadSettings;
  readonly runMaxEvents: number;
  readonly scan?: UploadScanner;
}

export interface ShareTarget {
  readonly teamId: string;
  readonly userId: string;
}

const fail = (
  code: Extract<ShareResult, { ok: false }>["code"],
  message: string,
  refusal?: ShareRefusal,
): ShareResult => ({ ok: false, code, message, ...(refusal ? { refusal } : {}) });

const RUN_ENDED = fail(
  "not_allowed",
  "The run has ended, so the file was not shared.",
  "run_not_active",
);
const OTHER_RUN = fail(
  "not_allowed",
  "This tool call id was already used by another run.",
  "not_allowed",
);
const NOT_SYNCED = fail(
  "not_synced",
  "The file changed or was not saved to the workspace copy. Try again.",
  "not_synced",
);
const NOT_FOUND = fail("not_found", "No such file in the workspace copy.", "not_found");
const STORAGE_FAILED = fail("storage_failed", "The file could not be shared. Try again.");

class RunEndedError extends Error {}
class QuotaError extends Error {}

const PENDING_GRACE = sql.raw(`interval '1 hour'`);
const WORKSPACE_ROOT = "/workspace/";

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = e.cause?.code ?? e.code;
  return typeof code === "string" ? code : undefined;
}

/** `input.path` as a manifest path: `/workspace/a/b` and `a/b` both give `a/b`; else undefined. */
export function manifestPath(inputPath: string): string | undefined {
  const rel = inputPath.startsWith(WORKSPACE_ROOT)
    ? inputPath.slice(WORKSPACE_ROOT.length)
    : inputPath;
  if (rel === "" || rel.startsWith("/")) return undefined;
  return rel.replace(/^(\.\/)+/, "");
}

function toShared(row: FileRow, createdAt: Date): SharedFile {
  return {
    file_id: row.id,
    name: row.name,
    mime_type: row.mimeType,
    size_bytes: row.sizeBytes,
    scan: row.scanStatus === "clean" ? "clean" : "skipped",
    created_at: createdAt.toISOString(),
    sha256: row.sha256,
  };
}

interface FileRow {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly scanStatus: string;
}

async function existing(tx: KobeTx, teamId: string, toolCallId: string) {
  const res = await tx.execute<{
    id: string;
    name: string;
    mime_type: string;
    size_bytes: string;
    sha256: string;
    scan_status: string;
    run_id: string | null;
    created_at: Date;
  }>(sql`
    SELECT id, name, mime_type, size_bytes, sha256, scan_status, run_id, created_at
      FROM files WHERE team_id = ${teamId} AND tool_call_id = ${toolCallId}`);
  const r = res.rows[0];
  if (!r) return undefined;
  return {
    runId: r.run_id,
    file: toShared(
      {
        id: r.id,
        name: r.name,
        mimeType: r.mime_type,
        sizeBytes: Number(r.size_bytes),
        sha256: r.sha256,
        scanStatus: r.scan_status,
      },
      new Date(r.created_at),
    ),
  };
}

function replay(
  prior: NonNullable<Awaited<ReturnType<typeof existing>>>,
  runId: string,
): ShareResult {
  return prior.runId === runId ? { ok: true, file: prior.file, replay: true } : OTHER_RUN;
}

async function runActive(tx: KobeTx, target: ShareTarget, frame: FileShareFrame): Promise<boolean> {
  const res = await tx.execute<{ status: string }>(sql`
    SELECT r.status FROM runs r
      JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
     WHERE r.team_id = ${target.teamId} AND r.id = ${frame.run_id}
       AND r.thread_id = ${frame.thread_id}
       AND t.team_id = ${target.teamId} AND t.owner_user_id = ${target.userId}`);
  const status = res.rows[0]?.status;
  return status === "running" || status === "waiting_approval";
}

/** The manifest object for the push, or a refusal. */
async function verifiedBlob(
  tx: KobeTx,
  target: ShareTarget,
  frame: FileShareFrame,
  path: string,
): Promise<{ blobKey: string } | ShareResult> {
  const entry = await currentEntry(tx, target, path);
  if (!entry) return NOT_FOUND;
  const ref = frame.workspace;
  if (
    entry.deleted ||
    entry.blobKey === null ||
    entry.rev !== ref.rev ||
    entry.sha256 !== ref.sha256 ||
    entry.size !== ref.size
  ) {
    return NOT_SYNCED;
  }
  return { blobKey: entry.blobKey };
}

async function discard(blobs: BlobStore, key: string): Promise<void> {
  try {
    await blobs.objects.delete([key]);
  } catch (err) {
    logger.warn({ err }, "share_file: could not delete an orphaned copy");
  }
}

async function headOf(blobs: BlobStore, key: string): Promise<Uint8Array> {
  const object = await blobs.objects.get(key);
  if (!object) throw new Error("shared copy is missing");
  const chunks: Buffer[] = [];
  let have = 0;
  try {
    for await (const chunk of object.body as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      have += chunk.length;
      if (have >= SNIFF_BYTES) break;
    }
  } finally {
    object.body.destroy();
  }
  return Buffer.concat(chunks).subarray(0, SNIFF_BYTES);
}

interface Stored {
  readonly fileId: string;
  readonly key: string;
  readonly name: string;
  readonly mime: string;
  readonly scan: "none" | "clean";
}

async function commit(
  deps: FileShareDeps,
  target: ShareTarget,
  frame: FileShareFrame,
  s: Stored,
): Promise<SharedFile> {
  const { teamId, userId } = target;
  const { size, sha256 } = frame.workspace;
  return withAppendTx(deps.db, teamId, async (tx) => {
    if (!(await runActive(tx, target, frame))) throw new RunEndedError();
    await lockTeamStorage(tx, teamId);
    const limit = await storageLimit(tx, teamId, deps.settings.defaultQuotaBytes);
    if ((await storageUsed(tx, teamId)) + size > limit) throw new QuotaError();
    const [row] = await tx
      .insert(files)
      .values({
        teamId,
        id: s.fileId,
        userId,
        threadId: frame.thread_id,
        kind: "shared",
        name: s.name,
        sizeBytes: size,
        sha256,
        mimeType: s.mime,
        blobRef: s.key,
        scanStatus: s.scan,
        runId: frame.run_id,
        toolCallId: frame.tool_call_id,
      })
      .returning({ createdAt: files.createdAt });
    if (!row) throw new Error("files insert returned no row");
    await tx.execute(
      sql`DELETE FROM retention_blob_deletions WHERE team_id = ${teamId} AND key = ${s.key}`,
    );
    await recordAudit(tx, {
      action: "workspace.file_shared",
      actor: { kind: "user", id: userId },
      teamId,
      target: { userId, sharedId: s.fileId, bytes: size },
    });
    await appendShared(tx, deps, teamId, frame, s, size);
    return toShared(
      { id: s.fileId, name: s.name, mimeType: s.mime, sizeBytes: size, sha256, scanStatus: s.scan },
      row.createdAt,
    );
  });
}

async function appendShared(
  tx: KobeTx,
  deps: FileShareDeps,
  teamId: string,
  frame: FileShareFrame,
  s: Stored,
  size: number,
): Promise<void> {
  const run = await tx.execute<{ last_seq: number }>(sql`
    SELECT last_seq FROM runs WHERE team_id = ${teamId} AND id = ${frame.run_id}`);
  // Keep room for the terminal event (as the ingest does); the file itself is shared anyway.
  if ((run.rows[0]?.last_seq ?? deps.runMaxEvents) + 2 > deps.runMaxEvents) {
    logger.warn({ run_id: frame.run_id }, "file.shared event skipped: the run is at its event cap");
    return;
  }
  try {
    await appendRunEventsInTx(tx, teamId, frame.run_id, [
      {
        type: "file.shared",
        payload: {
          file_id: s.fileId,
          tool_call_id: frame.tool_call_id,
          name: s.name,
          size,
          mime_type: s.mime,
          ...(frame.input.description === undefined
            ? {}
            : { description: frame.input.description }),
        },
      },
    ]);
  } catch (err) {
    if (err instanceof AppendError && err.code === "run_finished") throw new RunEndedError();
    throw err;
  }
}

async function markPending(
  deps: FileShareDeps,
  target: ShareTarget,
  frame: FileShareFrame,
  key: string,
) {
  await withTeam(deps.db, target.teamId, (tx) =>
    tx.execute(sql`
      INSERT INTO retention_blob_deletions (team_id, key, thread_id, owner_user_id, enqueued_at)
      VALUES (${target.teamId}, ${key}, ${frame.thread_id}, ${target.userId}, now() + ${PENDING_GRACE})
      ON CONFLICT (team_id, key) DO NOTHING`),
  );
}

/** Pure checks of the frame against the install's limits; undefined = fine. */
function checkFrame(
  deps: FileShareDeps,
  frame: FileShareFrame,
): { path: string; name: string } | ShareResult {
  const path = manifestPath(frame.input.path);
  if (path === undefined || path !== frame.workspace.path) {
    return fail("not_allowed", "The file differs from the call that was allowed.", "path_mismatch");
  }
  const base = path.slice(path.lastIndexOf("/") + 1);
  const name = uploadFileNameSchema.safeParse(frame.input.name ?? base);
  if (!name.success) return fail("invalid_input", "The file name is not valid.");
  const limit = Math.min(FILE_SHARE_MAX_BYTES, deps.settings.maxFileBytes);
  if (frame.workspace.size > limit) {
    return fail("too_large", "This file is larger than the sharing limit.", "too_large");
  }
  return { path, name: name.data };
}

export async function shareFile(
  deps: FileShareDeps,
  target: ShareTarget,
  frame: FileShareFrame,
): Promise<ShareResult> {
  const { teamId } = target;
  const blobs = deps.blobs;
  if (!blobs) return fail("storage_failed", "File storage is not available.");
  const checked = checkFrame(deps, frame);
  if ("ok" in checked) return checked;

  // 1. Read-only checks, and the idempotent replay of a call already applied.
  const pre = await withTeam(deps.db, teamId, async (tx) => {
    const prior = await existing(tx, teamId, frame.tool_call_id);
    if (prior) return replay(prior, frame.run_id);
    if (!(await runActive(tx, target, frame))) return RUN_ENDED;
    return verifiedBlob(tx, target, frame, checked.path);
  });
  if ("ok" in pre) return pre;

  // 2. Copy the workspace object into the thread's tree.
  const fileId = randomUUID();
  const key = shareBlobKey(blobs.prefix, teamId, frame.thread_id, fileId);
  if (!threadKey(blobs.prefix, teamId, frame.thread_id, key)) return STORAGE_FAILED;
  let mime: string;
  try {
    await markPending(deps, target, frame, key);
    await blobs.objects.copy(pre.blobKey, key);
    mime = resolveMime(await headOf(blobs, key), undefined);
  } catch (err) {
    logger.error({ err, team_id: teamId }, "share_file copy failed");
    await discard(blobs, key);
    return STORAGE_FAILED;
  }

  // 3. Scan seam, then the row, audit and event in one transaction.
  try {
    const outcome = deps.scan
      ? await deps.scan({ key, size: frame.workspace.size, sha256: frame.workspace.sha256 })
      : "none";
    if (outcome === "rejected" || outcome === "unavailable") {
      await discard(blobs, key);
      return outcome === "rejected"
        ? fail("scan_rejected", "The file was rejected by the virus scan.", "scan_rejected")
        : fail("storage_failed", "The virus scan is not available right now. Try again.");
    }
    const file = await commit(deps, target, frame, {
      fileId,
      key,
      name: checked.name,
      mime,
      scan: outcome,
    });
    return { ok: true, file, replay: false };
  } catch (err) {
    return afterFailure(deps, target, frame, blobs, key, err);
  }
}

async function afterFailure(
  deps: FileShareDeps,
  target: ShareTarget,
  frame: FileShareFrame,
  blobs: BlobStore,
  key: string,
  err: unknown,
): Promise<ShareResult> {
  const runEnded =
    err instanceof RunEndedError || (err instanceof AppendError && err.code === "run_finished");
  // Only an error raised inside the transaction is a definite rollback; anything else (a failed
  // or ambiguous COMMIT) may have committed the row, so the object stays (retention keeps a
  // referenced one).
  if (runEnded || err instanceof QuotaError || pgCode(err) === "23505") await discard(blobs, key);
  if (runEnded) return RUN_ENDED;
  if (err instanceof QuotaError) {
    return fail(
      "quota_exceeded",
      "Your team has no storage left. Delete files or ask a team admin for more.",
      "quota_exceeded",
    );
  }
  if (pgCode(err) === "23505") {
    // A concurrent copy of the same tool call won: answer with its result.
    const prior = await withTeam(deps.db, target.teamId, (tx) =>
      existing(tx, target.teamId, frame.tool_call_id),
    );
    if (prior) return replay(prior, frame.run_id);
  }
  logger.error({ err, team_id: target.teamId }, "share_file write failed");
  return STORAGE_FAILED;
}

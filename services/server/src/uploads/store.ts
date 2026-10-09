import { randomUUID } from "node:crypto";
import { pipeline, type Readable } from "node:stream";
import {
  UPLOAD_ERROR_HTTP_STATUS,
  type UploadError,
  type UploadErrorCode,
  type UploadResponse,
} from "@kobe/protocol";
import { files, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { logger } from "../logger.js";
import { threadKey, type BlobStore } from "../retention/blobs.js";
import { uploadBlobKey } from "./keys.js";
import { UploadMeter, UploadTooLargeError } from "./meter.js";
import { resolveMime } from "./mime.js";
import { storageLimit, storageUsed, teamStorageAllows } from "./quota.js";
import type { UploadSettings } from "./settings.js";

/**
 * Stores one upload (KOBE-143 = 53c of KOBE-53, contract in docs/ledger/KOBE-141.md).
 *
 * Order, so a failed upload leaves no row and no object:
 *  1. read-only checks (thread is the caller's; the Content-Length is within the limits; the team
 *     isn't already at its quota);
 *  2. the bytes stream to S3 under a server-derived key through a meter (size limit enforced
 *     mid-stream, SHA-256 and the first bytes for sniffing computed on the way). A threaded key
 *     is queued in `retention_blob_deletions` first (due in an hour), so a crash leaves nothing
 *     the retention pass can't delete;
 *  3. the scan seam (ClamAV is KOBE-146);
 *  4. one transaction under the team's storage lock: usage + size against the quota, then the
 *     `files` row and the audit event. Over quota: the object is deleted, nothing is written.
 */

export type ScanOutcome = "none" | "clean" | "rejected" | "unavailable";
/** Seam for KOBE-146: scan the stored object. Absent: not scanned (`scan_status` `none`). */
export type UploadScanner = (object: {
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
}) => Promise<ScanOutcome>;

export interface UploadDeps {
  readonly db: KobeDb;
  readonly blobs: BlobStore;
  readonly settings: UploadSettings;
  readonly scan?: UploadScanner;
}

export interface UploadCaller {
  readonly teamId: string;
  readonly userId: string;
}

export interface UploadInput {
  readonly threadId: string | undefined;
  readonly name: string;
  readonly declaredMime: string;
  readonly file: Readable;
  /** The request's Content-Length when known (an upper bound of the file's size). */
  readonly contentLength: number | undefined;
}

export type StoreResult =
  | { readonly ok: true; readonly file: UploadResponse }
  | { readonly ok: false; readonly status: 404 | 413 | 403 | 422 | 503; readonly body: ErrorBody };

type ErrorBody = UploadError | { readonly code: string; readonly message: string };

/** Multipart framing around the file in Content-Length (boundaries, headers, `thread_id`). */
const FRAMING_SLACK_BYTES = 64 * 1024;
/** Longest an upload in flight is shielded from the retention pass's leftover cleanup. */
const PENDING_GRACE = sql.raw(`interval '1 hour'`);

const MESSAGES = {
  file_too_large: "This file is larger than the upload limit.",
  message_too_large: "This file is larger than the limit for one message.",
  quota_exceeded: "Your team has no storage left. Delete files or ask a team admin for more.",
  scan_rejected: "The file was rejected by the virus scan.",
  scan_unavailable: "The virus scan is not available right now. Try again in a moment.",
} as const satisfies Record<UploadErrorCode, string>;

function refusal(code: UploadErrorCode, limitBytes?: number): StoreResult {
  return {
    ok: false,
    status: UPLOAD_ERROR_HTTP_STATUS[code],
    body: {
      code,
      message: MESSAGES[code],
      ...(limitBytes === undefined ? {} : { limit_bytes: limitBytes }),
    },
  };
}

const THREAD_NOT_FOUND: StoreResult = {
  ok: false,
  status: 404,
  body: { code: "thread_not_found", message: "No thread with that id." },
};
const STORAGE_UNAVAILABLE: StoreResult = {
  ok: false,
  status: 503,
  body: { code: "storage_unavailable", message: "The file could not be stored. Try again." },
};

type Reason = "file_too_large" | "message_too_large" | "quota_exceeded";

/** Audits a refusal (counts only, no name or content) in a transaction of its own. */
async function auditRefused(
  deps: UploadDeps,
  caller: UploadCaller,
  reason: Reason,
  bytes: number,
): Promise<void> {
  try {
    await withTeam(deps.db, caller.teamId, (tx) =>
      recordAudit(tx, {
        action: "workspace.upload_refused",
        teamId: caller.teamId,
        target: { userId: caller.userId, reason, bytes },
      }),
    );
  } catch (err) {
    // The upload is refused either way; losing the audit row is logged for operators.
    logger.error({ err, teamId: caller.teamId }, "upload refusal could not be audited");
  }
}

async function refuse(
  deps: UploadDeps,
  caller: UploadCaller,
  reason: Reason,
  bytes: number,
  limitBytes?: number,
): Promise<StoreResult> {
  await auditRefused(deps, caller, reason, bytes);
  return refusal(reason, limitBytes);
}

/** The smallest limit applying to one file, and the code reported when it is exceeded. */
export function fileLimit(s: UploadSettings): { bytes: number; code: Reason } {
  return s.maxFileBytes <= s.maxMessageBytes
    ? { bytes: s.maxFileBytes, code: "file_too_large" }
    : { bytes: s.maxMessageBytes, code: "message_too_large" };
}

async function preflight(deps: UploadDeps, caller: UploadCaller, threadId: string | undefined) {
  return withTeam(deps.db, caller.teamId, async (tx) => {
    if (threadId !== undefined) {
      const res = await tx.execute(sql`
        SELECT 1 FROM threads
         WHERE team_id = ${caller.teamId} AND id = ${threadId}
           AND owner_user_id = ${caller.userId} AND deleted_at IS NULL`);
      if (res.rows.length === 0) return { threadFound: false, full: false } as const;
    }
    const limit = await storageLimit(tx, caller.teamId, deps.settings.defaultQuotaBytes);
    return { threadFound: true, full: (await storageUsed(tx, caller.teamId)) >= limit } as const;
  });
}

async function markPending(
  deps: UploadDeps,
  caller: UploadCaller,
  threadId: string,
  key: string,
): Promise<void> {
  await withTeam(deps.db, caller.teamId, (tx) =>
    tx.execute(sql`
      INSERT INTO retention_blob_deletions (team_id, key, thread_id, owner_user_id, enqueued_at)
      VALUES (${caller.teamId}, ${key}, ${threadId}, ${caller.userId}, now() + ${PENDING_GRACE})
      ON CONFLICT (team_id, key) DO NOTHING`),
  );
}

async function discard(deps: UploadDeps, key: string): Promise<void> {
  try {
    await deps.blobs.objects.delete([key]);
  } catch (err) {
    logger.warn({ err }, "upload: could not delete an orphaned object");
  }
}

class QuotaError extends Error {}

interface Stored {
  readonly fileId: string;
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
  readonly mime: string;
  readonly scan: "none" | "clean";
}

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = e.cause?.code ?? e.code;
  return typeof code === "string" ? code : undefined;
}

async function commit(
  deps: UploadDeps,
  caller: UploadCaller,
  input: UploadInput,
  s: Stored,
): Promise<UploadResponse> {
  const { teamId, userId } = caller;
  return withTeam(deps.db, teamId, async (tx: KobeTx) => {
    if (!(await teamStorageAllows(tx, teamId, deps.settings.defaultQuotaBytes, s.size))) {
      throw new QuotaError();
    }
    const [row] = await tx
      .insert(files)
      .values({
        teamId,
        id: s.fileId,
        userId,
        threadId: input.threadId ?? null,
        kind: "upload",
        name: input.name,
        sizeBytes: s.size,
        sha256: s.sha256,
        mimeType: s.mime,
        blobRef: s.key,
        scanStatus: s.scan,
      })
      .returning({ createdAt: files.createdAt });
    if (!row) throw new Error("files insert returned no row");
    await tx.execute(
      sql`DELETE FROM retention_blob_deletions WHERE team_id = ${teamId} AND key = ${s.key}`,
    );
    await recordAudit(tx, {
      action: "workspace.upload_stored",
      teamId,
      target: {
        userId,
        fileId: s.fileId,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        bytes: s.size,
      },
    });
    return {
      file_id: s.fileId,
      name: input.name,
      mime_type: s.mime,
      size_bytes: s.size,
      scan: s.scan === "clean" ? "clean" : "skipped",
      created_at: row.createdAt.toISOString(),
    } satisfies UploadResponse;
  });
}

export async function storeUpload(
  deps: UploadDeps,
  caller: UploadCaller,
  input: UploadInput,
): Promise<StoreResult> {
  const { teamId, userId } = caller;
  const limit = fileLimit(deps.settings);
  if (
    input.contentLength !== undefined &&
    input.contentLength > limit.bytes + FRAMING_SLACK_BYTES
  ) {
    return refuse(deps, caller, limit.code, 0, limit.bytes);
  }
  const pre = await preflight(deps, caller, input.threadId);
  if (!pre.threadFound) return THREAD_NOT_FOUND;
  if (pre.full) return refuse(deps, caller, "quota_exceeded", 0);

  const fileId = randomUUID();
  const key = uploadBlobKey(deps.blobs.prefix, teamId, userId, input.threadId, fileId);
  if (input.threadId !== undefined && !threadKey(deps.blobs.prefix, teamId, input.threadId, key)) {
    return STORAGE_UNAVAILABLE;
  }
  const meter = new UploadMeter(limit.bytes);
  try {
    if (input.threadId !== undefined) await markPending(deps, caller, input.threadId, key);
    pipeline(input.file, meter, () => undefined);
    await deps.blobs.objects.putStream(key, meter);
  } catch (err) {
    meter.destroy();
    input.file.destroy();
    await discard(deps, key);
    if (err instanceof UploadTooLargeError || meter.bytes > limit.bytes) {
      return refuse(deps, caller, limit.code, meter.bytes, limit.bytes);
    }
    logger.error({ err, teamId }, "upload failed");
    return STORAGE_UNAVAILABLE;
  }

  const size = meter.bytes;
  const stored: Omit<Stored, "scan"> = {
    fileId,
    key,
    size,
    sha256: meter.digest(),
    mime: resolveMime(meter.head, input.declaredMime),
  };
  try {
    const outcome = deps.scan ? await deps.scan({ key, size, sha256: stored.sha256 }) : "none";
    if (outcome === "rejected" || outcome === "unavailable") {
      await discard(deps, key);
      return refusal(outcome === "rejected" ? "scan_rejected" : "scan_unavailable");
    }
    return {
      ok: true,
      file: await commit(deps, caller, input, { ...stored, scan: outcome }),
    };
  } catch (err) {
    await discard(deps, key);
    if (err instanceof QuotaError) return refuse(deps, caller, "quota_exceeded", size);
    if (pgCode(err) === "23503") return THREAD_NOT_FOUND;
    logger.error({ err, teamId }, "upload could not be recorded");
    return STORAGE_UNAVAILABLE;
  }
}

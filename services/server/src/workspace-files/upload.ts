import { randomUUID } from "node:crypto";
import { pipeline, type Readable } from "node:stream";
import { withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import type { WorkspaceFileError } from "@kobe/protocol";
import { logger } from "../logger.js";
import { recordAudit } from "../audit/record.js";
import { UploadMeter, UploadTooLargeError } from "../uploads/meter.js";
import { lockTeamStorage, storageLimit, storageUsed } from "../uploads/quota.js";
import { workspaceBlobKey, workspacePrefix, type WorkspaceOwner } from "../workspace-sync/keys.js";
import { resolveLimits } from "../workspace-sync/quota.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";
import {
  blobState,
  finishUpload,
  lockWorkspace,
  recordBlob,
  reserveUpload,
  type StoredEntry,
} from "../workspace-sync/store.js";
import { pathIsTaken } from "./browse.js";
import { ancestorsOf, copyPath } from "./paths.js";

export type Failure = {
  readonly ok: false;
  readonly status: 409 | 413 | 502 | 503 | 507;
  readonly code: WorkspaceFileError["code"];
  readonly message: string;
};
export type UploadResult = { readonly ok: true; readonly entry: StoredEntry } | Failure;

export const fail = (
  status: Failure["status"],
  code: Failure["code"],
  message: string,
): Failure => ({
  ok: false,
  status,
  code,
  message,
});
const TAKEN = fail(409, "already_exists", "A file or folder with that name already exists.");
export const QUOTA = fail(507, "quota_exceeded", "Your workspace has no room for this file.");

/** The upload being received: its bytes arrive as a stream, size and hash are known at the end. */
export interface IncomingFile {
  readonly body: Readable;
  /** Most bytes accepted; the stream is cut off past it (mid-stream, never fully received). */
  readonly limitBytes: number;
  /** The team's storage quota default (KOBE-143), used when the team has no limit of its own. */
  readonly teamQuotaDefaultBytes: number;
  /**
   * A rail drop into uploads/ (KOBE-199): a clash never fails, the file takes the first free
   * `name (n).ext`, chosen under the workspace lock; the audit event records `area: "drop"`.
   */
  readonly drop?: boolean;
}

/** Copies tried after a drop's name clash before giving up (already_exists). */
const MAX_COPIES = 100;

/** The path to write: `path`, or for a drop the first free copy of it; undefined when none is. */
async function freePath(
  tx: KobeTx,
  owner: WorkspaceOwner,
  path: string,
  ancestors: readonly string[],
  copy: boolean,
): Promise<string | undefined> {
  if (!(await pathIsTaken(tx, owner, path, ancestors))) return path;
  for (let n = 1; copy && n <= MAX_COPIES; n += 1) {
    const candidate = copyPath(path, n);
    if (!(await pathIsTaken(tx, owner, candidate, ancestors))) return candidate;
  }
  return undefined;
}

/**
 * A browser upload into the user's own workspace (KOBE-148, streaming since KOBE-184). Same
 * S3-first pattern as the sandbox's blob PUT (KOBE-27) and the uploads pipeline (KOBE-143):
 *  1. read-only checks (the path is free, the team has room at all);
 *  2. the body streams through KOBE-143's `UploadMeter` (size limit, SHA-256) into a staging
 *     object with `putStream`: bounded memory, whatever the file's size;
 *  3. reserve the workspace's room for the now-known size, server-side copy staging to the
 *     content-addressed key (skipped when the workspace already holds that content), record the blob;
 *  4. in one team transaction with its audit event: workspace quota, then the team's storage
 *     quota under KOBE-143's per-team lock, then `putServerFile` (origin `server`).
 * The staging object is always deleted. The sandbox pulls the file before its next run; an edit
 * based on an older revision becomes a conflict copy on its side. Never overwrites.
 */
export async function uploadToWorkspace(
  db: KobeDb,
  sync: WorkspaceSync,
  owner: WorkspaceOwner,
  path: string,
  incoming: IncomingFile,
): Promise<UploadResult> {
  const ancestors = ancestorsOf(path);
  const copy = incoming.drop === true;
  const pre = await withTeam(db, owner.teamId, async (tx) => {
    if (!copy && (await pathIsTaken(tx, owner, path, ancestors))) return "taken" as const;
    const limit = await storageLimit(tx, owner.teamId, incoming.teamQuotaDefaultBytes);
    return (await storageUsed(tx, owner.teamId)) >= limit ? ("full" as const) : ("ok" as const);
  });
  if (pre !== "ok") {
    incoming.body.destroy(); // refused before reading: never leave the body to the socket
    return pre === "taken" ? TAKEN : QUOTA;
  }

  const staging = `${workspacePrefix(sync.prefix, owner)}incoming/${randomUUID()}`;
  const meter = new UploadMeter(incoming.limitBytes);
  try {
    pipeline(incoming.body, meter, () => undefined);
    await sync.objects.putStream(staging, meter);
  } catch (err) {
    meter.destroy();
    incoming.body.destroy();
    await discard(sync, staging);
    if (err instanceof UploadTooLargeError || meter.bytes > incoming.limitBytes) {
      return fail(
        413,
        "file_too_large",
        `Files over ${incoming.limitBytes} bytes are not accepted.`,
      );
    }
    logger.error({ err, teamId: owner.teamId }, "workspace upload failed");
    return fail(502, "sandbox_unavailable", "Object storage is unavailable; try again.");
  }
  try {
    return await commitUpload(db, sync, owner, path, ancestors, staging, meter, incoming);
  } finally {
    await discard(sync, staging);
  }
}

async function discard(sync: WorkspaceSync, key: string): Promise<void> {
  try {
    await sync.objects.delete([key]);
  } catch (err) {
    logger.warn({ err }, "workspace upload: could not delete the staging object");
  }
}

async function commitUpload(
  db: KobeDb,
  sync: WorkspaceSync,
  owner: WorkspaceOwner,
  path: string,
  ancestors: readonly string[],
  staging: string,
  meter: UploadMeter,
  incoming: IncomingFile,
): Promise<UploadResult> {
  const { limits } = sync;
  const size = meter.bytes;
  const sha256 = meter.digest();
  if (size > limits.maxFileBytes) {
    return fail(413, "file_too_large", `Files over ${limits.maxFileBytes} bytes are not accepted.`);
  }
  const blobKey = workspaceBlobKey(sync.prefix, owner, sha256);
  const reserved = await withTeam(db, owner.teamId, async (tx) => {
    if (!incoming.drop && (await pathIsTaken(tx, owner, path, ancestors))) return "taken" as const;
    const held = await blobState(tx, owner, sha256);
    if (held !== "absent") return held;
    const ok = await reserveUpload(tx, owner, size, resolveLimits(limits));
    return ok ? ("reserved" as const) : ("over_quota" as const);
  });
  if (reserved === "taken") return TAKEN;
  if (reserved === "over_quota") return QUOTA;
  if (reserved === "deleting") {
    return fail(503, "sandbox_unavailable", "That content is being cleaned up; try again shortly.");
  }
  if (reserved === "reserved") {
    const stored = await storeBlob(db, sync, owner, { sha256, blobKey, size }, () =>
      sync.objects.copy(staging, blobKey),
    );
    if (stored) return stored;
  }

  return withTeam(db, owner.teamId, async (tx): Promise<UploadResult> => {
    const state = await lockWorkspace(tx, owner);
    // Under the workspace lock: the clash check (and a drop's free name) is atomic with the write.
    const target = await freePath(tx, owner, path, ancestors, incoming.drop === true);
    if (target === undefined) return TAKEN;
    const decision = await sync.quota(tx, {
      owner,
      fileBytes: size,
      liveFiles: state.liveFiles + 1,
      liveBytes: state.liveBytes + size,
    });
    if (!decision.ok) return QUOTA;
    // The team's storage quota (KOBE-143): check and write under its lock, so uploads racing
    // across the team's members cannot jointly pass the limit.
    await lockTeamStorage(tx, owner.teamId);
    const limit = await storageLimit(tx, owner.teamId, incoming.teamQuotaDefaultBytes);
    if ((await storageUsed(tx, owner.teamId)) + size > limit) return QUOTA;
    const entry = await sync.putServerFile(
      tx,
      owner,
      { path: target, sha256, size, blobKey },
      "user",
    );
    await recordAudit(tx, {
      action: "workspace.file_uploaded",
      teamId: owner.teamId,
      target: { userId: owner.userId, bytes: size, ...(incoming.drop ? { area: "drop" } : {}) },
    });
    return { ok: true, entry };
  });
}

/**
 * Writes the content to its key (`write`: the upload's staging copy, a save's put) and records the
 * blob; always ends the reservation `reserveUpload` made for it.
 */
export async function storeBlob(
  db: KobeDb,
  sync: WorkspaceSync,
  owner: WorkspaceOwner,
  blob: { readonly sha256: string; readonly blobKey: string; readonly size: number },
  write: () => Promise<void>,
): Promise<Failure | undefined> {
  const { sha256, size } = blob;
  let added = false;
  let finished = false;
  try {
    await write();
    const recorded = await withTeam(db, owner.teamId, async (tx) => {
      const outcome = await recordBlob(tx, owner, sha256, size);
      await finishUpload(tx, owner, size, outcome === "added");
      return outcome;
    });
    finished = true;
    added = recorded === "added";
    if (recorded === "deleting") {
      return fail(503, "sandbox_unavailable", "That content is being cleaned up; try again.");
    }
    return undefined;
  } catch (err) {
    logger.error({ err, teamId: owner.teamId }, "workspace upload failed");
    return fail(502, "sandbox_unavailable", "Object storage is unavailable; try again.");
  } finally {
    if (!finished) {
      // A failed upload still ends its reservation (a crash leaves it to collection).
      await withTeam(db, owner.teamId, (tx) => finishUpload(tx, owner, size, added)).catch(
        (err: unknown) => logger.error({ err }, "could not end an upload reservation"),
      );
    }
  }
}

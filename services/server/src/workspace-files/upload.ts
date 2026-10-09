import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { withTeam, type KobeDb } from "@kobe/db";
import type { WorkspaceFileError } from "@kobe/protocol";
import { logger } from "../logger.js";
import { recordAudit } from "../audit/record.js";
import { workspaceBlobKey, type WorkspaceOwner } from "../workspace-sync/keys.js";
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
import { ancestorsOf } from "./paths.js";

type Failure = {
  readonly ok: false;
  readonly status: 409 | 413 | 502 | 503 | 507;
  readonly code: WorkspaceFileError["code"];
  readonly message: string;
};
export type UploadResult = { readonly ok: true; readonly entry: StoredEntry } | Failure;

const fail = (status: Failure["status"], code: Failure["code"], message: string): Failure => ({
  ok: false,
  status,
  code,
  message,
});
const TAKEN = fail(409, "already_exists", "A file or folder with that name already exists.");
const QUOTA = fail(507, "quota_exceeded", "Your workspace has no room for this file.");

/**
 * A browser upload into the user's own workspace (KOBE-148), the same S3-first pattern as the
 * sandbox's blob PUT (KOBE-27): reserve room, store the content under the workspace's own
 * content-addressed key, record the blob, then — in one team transaction with its audit event —
 * write the manifest row with `putServerFile` (origin `server`). The sandbox pulls it before its
 * next run; a sandbox edit based on an older revision then becomes a conflict copy on its side.
 * Never overwrites: an existing path is refused. TODO(KOBE-143): switch to the shared uploads
 * pipeline (scan, streaming) once it lands.
 */
export async function uploadToWorkspace(
  db: KobeDb,
  sync: WorkspaceSync,
  owner: WorkspaceOwner,
  path: string,
  data: Buffer,
): Promise<UploadResult> {
  const { limits } = sync;
  if (data.length > limits.maxFileBytes) {
    return fail(413, "file_too_large", `Files over ${limits.maxFileBytes} bytes are not accepted.`);
  }
  const sha256 = createHash("sha256").update(data).digest("hex");
  const blobKey = workspaceBlobKey(sync.prefix, owner, sha256);
  const ancestors = ancestorsOf(path);

  const reserved = await withTeam(db, owner.teamId, async (tx) => {
    if (await pathIsTaken(tx, owner, path, ancestors)) return "taken" as const;
    const held = await blobState(tx, owner, sha256);
    if (held !== "absent") return held;
    const ok = await reserveUpload(tx, owner, data.length, resolveLimits(limits));
    return ok ? ("reserved" as const) : ("over_quota" as const);
  });
  if (reserved === "taken") return TAKEN;
  if (reserved === "over_quota") return QUOTA;
  if (reserved === "deleting") {
    return fail(503, "sandbox_unavailable", "That content is being cleaned up; try again shortly.");
  }
  if (reserved === "reserved") {
    const stored = await storeBlob(db, sync, owner, sha256, blobKey, data);
    if (stored) return stored;
  }

  return withTeam(db, owner.teamId, async (tx): Promise<UploadResult> => {
    const state = await lockWorkspace(tx, owner);
    if (await pathIsTaken(tx, owner, path, ancestors)) return TAKEN;
    const decision = await sync.quota(tx, {
      owner,
      fileBytes: data.length,
      liveFiles: state.liveFiles + 1,
      liveBytes: state.liveBytes + data.length,
    });
    if (!decision.ok) return QUOTA;
    const entry = await sync.putServerFile(
      tx,
      owner,
      { path, sha256, size: data.length, blobKey },
      "user",
    );
    await recordAudit(tx, {
      action: "workspace.file_uploaded",
      teamId: owner.teamId,
      target: { userId: owner.userId, bytes: data.length },
    });
    return { ok: true, entry };
  });
}

/** Puts the bytes in the object store and records the blob; always ends the reservation. */
async function storeBlob(
  db: KobeDb,
  sync: WorkspaceSync,
  owner: WorkspaceOwner,
  sha256: string,
  blobKey: string,
  data: Buffer,
): Promise<Failure | undefined> {
  let added = false;
  let finished = false;
  try {
    await sync.objects.put(blobKey, Readable.from([data]), data.length);
    const recorded = await withTeam(db, owner.teamId, async (tx) => {
      const outcome = await recordBlob(tx, owner, sha256, data.length);
      await finishUpload(tx, owner, data.length, outcome === "added");
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
      await withTeam(db, owner.teamId, (tx) => finishUpload(tx, owner, data.length, added)).catch(
        (err: unknown) => logger.error({ err }, "could not end an upload reservation"),
      );
    }
  }
}

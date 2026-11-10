import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import type { WorkspaceSaveConflict } from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";
import { teamStorageAllows } from "../uploads/quota.js";
import { workspaceBlobKey, type WorkspaceOwner } from "../workspace-sync/keys.js";
import { resolveLimits } from "../workspace-sync/quota.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";
import {
  blobState,
  countedBytes,
  currentEntry,
  lockWorkspace,
  reserveUpload,
  type StoredEntry,
} from "../workspace-sync/store.js";
import { WRITE_SPAN, lockWaitSpan, s3PutSpan, writeTxSpan } from "../workspace-sync/write-spans.js";
import { pathIsTaken } from "./browse.js";
import { ancestorsOf } from "./paths.js";
import {
  fail,
  OBJECTS,
  TAKEN,
  QUOTA,
  READ_ONLY,
  resultOutcome,
  storeBlob,
  type Failure,
} from "./upload.js";
import { checkoutsHold } from "../workspace-sync/checkouts.js";
import { teamObjectsAllow } from "../uploads/quota.js";

/** The version a save found instead of its base: null when the file no longer exists. */
export type SaveConflict = {
  readonly ok: false;
  readonly status: 409;
  readonly code: "version_conflict";
  readonly message: string;
  readonly current: WorkspaceSaveConflict["current"];
};

export type SaveResult =
  | { readonly ok: true; readonly entry: StoredEntry; readonly changed: boolean }
  | Failure
  | SaveConflict;

export interface SaveRequest {
  readonly path: string;
  /**
   * The version the editor loaded (`sha256` of the synced copy); undefined creates a new file
   * (KOBE-591: accepting a proposed new file), refused when anything is at the path.
   */
  readonly baseSha256: string | undefined;
  readonly content: Buffer;
  /** Most bytes accepted: the browser upload's limit. */
  readonly limitBytes: number;
  /** The team's storage quota default (KOBE-143), used when the team has no limit of its own. */
  readonly teamQuotaDefaultBytes: number;
}

const MTIME_PRECISION = /\.\d+Z$/;

function conflict(current: StoredEntry | undefined): SaveConflict {
  const live = current !== undefined && !current.deleted && current.sha256 !== undefined;
  return {
    ok: false,
    status: 409,
    code: "version_conflict",
    message: live
      ? "The file changed since you opened it. Reload it and apply your edit again."
      : "The file no longer exists.",
    current:
      live && current.sha256 !== undefined
        ? {
            sha256: current.sha256,
            size_bytes: current.size,
            mtime: new Date(current.mtime_ms).toISOString().replace(MTIME_PRECISION, "Z"),
          }
        : null,
  };
}

/**
 * The live file at `path` still has `base` (or, without a base, there is no live file):
 * undefined, else the conflict to answer.
 */
function baseMismatch(
  current: StoredEntry | undefined,
  base: string | undefined,
): SaveConflict | undefined {
  const live = current !== undefined && !current.deleted && current.blobKey !== null;
  if (base === undefined) return live ? conflict(current) : undefined;
  return live && current.sha256 === base ? undefined : conflict(current);
}

/** A new file where a folder is, or inside a file (KOBE-591). */
async function newPathTaken(
  tx: KobeTx,
  owner: WorkspaceOwner,
  request: SaveRequest,
): Promise<boolean> {
  return (
    request.baseSha256 === undefined &&
    (await pathIsTaken(tx, owner, request.path, ancestorsOf(request.path)))
  );
}

/**
 * The file editor's save (KOBE-462, file-editor.ts; spec FE4): replaces an existing file of the
 * member's own workspace when its synced copy still has the version the editor loaded. The same
 * path as a browser upload (upload.ts), with the base check instead of "never overwrite":
 *  1. size limits; the content's SHA-256; a read-only base check (unchanged content: no write);
 *  2. the content goes to its content-addressed key under a workspace reservation (skipped when
 *     the workspace already holds that content), the blob recorded;
 *  3. one team transaction: the workspace lock, the base check again (atomic with the write), the
 *     workspace quota for the size change, the team storage quota under its lock, `putServerFile`
 *     (a new revision, origin `server`) and the `workspace.file_saved` audit event.
 * The sandbox pulls the new revision before its next run (as an upload); an agent edit of the old
 * revision becomes a conflict copy on its side, so the member's save is never lost.
 */
export async function saveWorkspaceFile(
  db: KobeDb,
  sync: WorkspaceSync,
  owner: WorkspaceOwner,
  request: SaveRequest,
): Promise<SaveResult> {
  const size = request.content.length;
  const max = Math.min(request.limitBytes, sync.limits.maxFileBytes);
  if (size > max) return fail(413, "file_too_large", `Files over ${max} bytes are not accepted.`);
  const sha256 = createHash("sha256").update(request.content).digest("hex");
  const blobKey = workspaceBlobKey(sync.prefix, owner, sha256);

  const check = () =>
    withTeam(db, owner.teamId, async (tx) => {
      const current = await currentEntry(tx, owner, request.path);
      const mismatch = baseMismatch(current, request.baseSha256);
      if (mismatch) return mismatch;
      if (await newPathTaken(tx, owner, request)) return TAKEN;
      if (sha256 === request.baseSha256 && current) return { unchanged: current };
      const held = await blobState(tx, owner, sha256);
      if (held !== "absent") return held;
      if (!(await teamObjectsAllow(tx, owner.teamId, sync.teamMaxObjects))) {
        return "over_objects" as const;
      }
      const ok = await reserveUpload(tx, owner, size, resolveLimits(sync.limits));
      return ok ? ("reserved" as const) : ("over_quota" as const);
    });
  const pre = await writeTxSpan(WRITE_SPAN.reserveTx, "save", check, (r) =>
    typeof r !== "object" ? r : "unchanged" in r ? "unchanged" : r.code,
  );
  if (typeof pre === "object" && "unchanged" in pre) {
    return { ok: true, entry: pre.unchanged, changed: false };
  }
  if (typeof pre === "object") return pre;
  if (pre === "over_quota") return QUOTA;
  if (pre === "over_objects") return OBJECTS;
  if (pre === "deleting") {
    return fail(503, "sandbox_unavailable", "That content is being cleaned up; try again shortly.");
  }
  if (pre === "reserved") {
    const stored = await storeBlob(db, sync, owner, { sha256, blobKey, size, kind: "save" }, () =>
      s3PutSpan("save", "put", () =>
        sync.objects.put(blobKey, Readable.from([request.content]), size),
      ),
    );
    if (stored) return stored;
  }
  return commitSave(db, sync, owner, request, { sha256, blobKey, size });
}

async function commitSave(
  db: KobeDb,
  sync: WorkspaceSync,
  owner: WorkspaceOwner,
  request: SaveRequest,
  blob: { readonly sha256: string; readonly blobKey: string; readonly size: number },
): Promise<SaveResult> {
  const manifest = () =>
    withTeam(db, owner.teamId, (tx) => saveManifest(tx, sync, owner, request, blob));
  return writeTxSpan(WRITE_SPAN.manifestTx, "save", manifest, resultOutcome);
}

/** The save's manifest/team transaction: workspace lock, base check, quotas, row, audit. */
async function saveManifest(
  tx: KobeTx,
  sync: WorkspaceSync,
  owner: WorkspaceOwner,
  request: SaveRequest,
  blob: { readonly sha256: string; readonly blobKey: string; readonly size: number },
): Promise<SaveResult> {
  const state = await lockWaitSpan("save", "workspace", () => lockWorkspace(tx, owner));
  // KOBE-579: a path in a project folder needs the checkout still, under the lock.
  if (!(await checkoutsHold(tx, owner, [request.path]))) return READ_ONLY;
  // Under the workspace lock: the base check is atomic with the write.
  const current = await currentEntry(tx, owner, request.path);
  const mismatch = baseMismatch(current, request.baseSha256);
  if (mismatch) return mismatch;
  if (await newPathTaken(tx, owner, request)) return TAKEN;
  const created = request.baseSha256 === undefined;
  if (!created && current === undefined) return conflict(undefined);
  const live = created ? undefined : current;
  const delta = blob.size - (live ? countedBytes(live) : 0);
  const decision = await sync.quota(tx, {
    owner,
    fileBytes: blob.size,
    liveFiles: state.liveFiles + (created ? 1 : 0),
    liveBytes: state.liveBytes + delta,
  });
  if (!decision.ok) return QUOTA;
  const teamRoom = () => teamStorageAllows(tx, owner.teamId, request.teamQuotaDefaultBytes, delta);
  if (!(await lockWaitSpan("save", "team_storage", teamRoom))) {
    return QUOTA;
  }
  const entry = await sync.putServerFile(
    tx,
    owner,
    {
      path: request.path,
      sha256: blob.sha256,
      size: blob.size,
      blobKey: blob.blobKey,
      executable: live?.executable ?? false,
    },
    "user",
  );
  await recordAudit(tx, {
    action: "workspace.file_saved",
    teamId: owner.teamId,
    target: { userId: owner.userId, bytes: blob.size },
  });
  return { ok: true, entry, changed: true };
}

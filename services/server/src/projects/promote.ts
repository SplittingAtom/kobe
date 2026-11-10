import { randomUUID } from "node:crypto";
import {
  isLegalHoldViolation,
  isUnderLegalHold,
  lockLegalHolds,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import {
  PROJECT_FILE_MAX_BYTES,
  PROJECT_FILES_MAX,
  promotedFolderMessage,
  workspacePathSchema,
  type PromoteFolderRequest,
} from "@kobe/protocol";
import type { Logger } from "pino";
import type { BlobStore } from "../retention/blobs.js";
import { resolveMime } from "../uploads/mime.js";
import { lockTeamStorage } from "../uploads/quota.js";
import { deleteWorkspaceFiles } from "../workspace-files/delete.js";
import { areaOf, isInternalPath } from "../workspace-files/paths.js";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";
import { currentEntry, listLive, lockWorkspace } from "../workspace-sync/store.js";
import type { ProjectRow } from "./access.js";
import { copyVerified, sourceCheck, type Copy } from "./commits.js";
import type { ProjectMounts } from "./mounts.js";
import { createProject } from "./repository.js";
import { overLimit, type TeamLimits } from "./storage.js";
import { projectBlobKey, queueProjectBlobs, writeCommit, type TreeFile } from "./tree.js";

/**
 * Promote a My files folder to a project (KOBE-586, projects-in-conversations PF3-PF4). Like a
 * commit (`commits.ts`), in three steps so no transaction is held while bytes move:
 *  1. plan (read): the folder in the caller's own manifest (never `uploads/`, `projects/` or an
 *     internal path; never another member's), every limit (file count, file size, path rules,
 *     conflict copies), the legal hold, and the contents to copy;
 *  2. copy (no transaction): each content from the member's object to the new project's
 *     `blobs/<sha256>`, hash and size verified, its key reserved first in
 *     `retention_blob_deletions` (due in hours), so a failure leaves nothing the deleter won't take;
 *  3. write (legal-hold lock, the member's workspace lock, the team storage lock): plan again (the
 *     same files, else back to 2), the quota, then the project (caller = owner,
 *     `project.created`), its one commit (`project.committed`) and, only once both exist, the
 *     folder's Delete as the Files panel does it (tombstones the sandbox pulls,
 *     `workspace.file_deleted`). One transaction: any failure leaves My files and the projects
 *     as they were.
 * The caller then mounts the project for the member (PF3, MT1 creator rule in `mounts.ts`).
 */

export interface PromoteDeps {
  readonly db: KobeDb;
  readonly blobs: BlobStore | undefined;
  readonly sync: WorkspaceSync | undefined;
  readonly mounts: Pick<ProjectMounts, "reconcileUser">;
  readonly limits: TeamLimits & { readonly maxFileBytes: number };
  readonly log: Pick<Logger, "warn">;
}

export type PromoteRefusal =
  | "not_found"
  | "outside_my_files"
  | "not_a_folder"
  | "empty_folder"
  | "too_many_files"
  | "file_too_large"
  | "invalid_path"
  | "conflict_file"
  | "quota_exceeded"
  | "legal_hold"
  | "slug_taken"
  | "changed"
  | "storage_failed";

export type PromoteResult =
  | { readonly status: "created"; readonly project: ProjectRow }
  | {
      readonly status: "refused";
      readonly error: PromoteRefusal;
      /** The file (relative to the folder) a path or size refusal names. */
      readonly path?: string;
      readonly limit?: "bytes" | "objects";
    };

interface Plan {
  /** Path in the project -> the file, `mime` filled after the copy. */
  readonly files: ReadonlyMap<string, Omit<TreeFile, "mime">>;
  readonly copies: readonly Copy[];
  /** The folder's live rows (deleted from My files once the commit exists). */
  readonly live: readonly { readonly path: string; readonly size: number }[];
  /** What the plan saw, to tell a changed folder in step 3. */
  readonly fingerprint: string;
}

const refused = (
  error: PromoteRefusal,
  extra: { path?: string; limit?: "bytes" | "objects" } = {},
): PromoteResult => ({ status: "refused", error, ...extra });

const isConflictName = (path: string): boolean =>
  path.slice(path.lastIndexOf("/") + 1).includes(".conflict-");

const sumSizes = (copies: readonly Copy[]): number => copies.reduce((n, c) => n + c.size, 0);

/** Step 1 (and again in step 3). */
async function plan(
  tx: KobeTx,
  deps: Pick<PromoteDeps, "limits"> & { readonly prefix: string },
  owner: WorkspaceOwner,
  folder: string,
  projectId: string,
): Promise<Plan | PromoteResult> {
  if (isInternalPath(folder)) return refused("not_found");
  if (areaOf(folder) !== "workspace") return refused("outside_my_files");
  const exact = await currentEntry(tx, owner, folder);
  if (exact && !exact.deleted) return refused("not_a_folder");
  const live = await listLive(tx, owner, `${folder}/`, PROJECT_FILES_MAX + 1);
  if (live.length === 0) return refused("empty_folder");
  if (live.length > PROJECT_FILES_MAX) return refused("too_many_files");
  if (await isUnderLegalHold(tx, owner.teamId, owner.userId)) return refused("legal_hold");
  const maxBytes = Math.min(PROJECT_FILE_MAX_BYTES, deps.limits.maxFileBytes);
  for (const e of live) {
    const rel = e.path.slice(folder.length + 1);
    if (!workspacePathSchema.safeParse(rel).success || isInternalPath(rel)) {
      return refused("invalid_path", { path: rel });
    }
    if (e.size > maxBytes) return refused("file_too_large", { path: rel });
    if (isConflictName(rel)) return refused("conflict_file", { path: rel });
  }
  const allowed = await sourceCheck(
    tx,
    deps.prefix,
    owner,
    live.map((e) => e.blobKey ?? ""),
  );
  const files = new Map<string, Omit<TreeFile, "mime">>();
  const copies = new Map<string, Copy>();
  for (const e of live) {
    const rel = e.path.slice(folder.length + 1);
    if (e.sha256 === undefined || e.blobKey === null || !allowed(e.blobKey)) {
      return refused("storage_failed", { path: rel });
    }
    const key = projectBlobKey(deps.prefix, owner.teamId, projectId, e.sha256);
    if (!copies.has(e.sha256)) {
      copies.set(e.sha256, { sha256: e.sha256, size: e.size, source: e.blobKey, key });
    }
    files.set(rel, {
      path: rel,
      sha256: e.sha256,
      size: e.size,
      executable: e.executable,
      blobRef: key,
    });
  }
  return {
    files,
    copies: [...copies.values()],
    live: live.map((e) => ({ path: e.path, size: e.size })),
    fingerprint: live.map((e) => `${e.path}\0${e.sha256}\0${e.size}\0${e.executable}`).join("\n"),
  };
}

const MAX_ROUNDS = 3;

export async function promoteFolder(
  deps: PromoteDeps,
  owner: WorkspaceOwner,
  request: PromoteFolderRequest,
): Promise<PromoteResult> {
  const { sync, blobs } = deps;
  if (!sync || !blobs) return refused("storage_failed");
  const projectId = randomUUID();
  const planDeps = { limits: deps.limits, prefix: blobs.prefix };
  const mimes = new Map<string, string>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const planned = await withTeam(deps.db, owner.teamId, (tx) =>
      plan(tx, planDeps, owner, request.path, projectId),
    );
    if ("status" in planned) return planned;
    const missing = planned.copies.filter((c) => !mimes.has(c.sha256));
    if (missing.length > 0) {
      // Fail fast on the quota before moving bytes (the write step checks again under the lock).
      const early = await withTeam(deps.db, owner.teamId, (tx) =>
        overLimit(tx, owner.teamId, deps.limits, sumSizes(planned.copies), planned.copies.length),
      );
      if (early !== undefined) return refused("quota_exceeded", { limit: early });
      await withTeam(deps.db, owner.teamId, (tx) =>
        queueProjectBlobs(
          tx,
          owner.teamId,
          projectId,
          owner.userId,
          missing.map((c) => c.key),
          "reservation",
        ),
      );
      for (const copy of missing) {
        try {
          mimes.set(copy.sha256, resolveMime(await copyVerified(blobs.objects, copy), undefined));
        } catch (err) {
          deps.log.warn({ err, team_id: owner.teamId }, "promote to project: a copy failed");
          return refused("storage_failed");
        }
      }
    }
    const written = await writeStep(deps, sync, owner, request, projectId, planned, mimes);
    if (written === "again") continue;
    if (written.status === "created") {
      // PF3: the creator sees the project under Projects at once (failures only log; the next
      // run start reconciles again).
      await deps.mounts.reconcileUser(owner.teamId, owner.userId);
    }
    return written;
  }
  return refused("changed");
}

async function writeStep(
  deps: PromoteDeps,
  sync: WorkspaceSync,
  owner: WorkspaceOwner,
  request: PromoteFolderRequest,
  projectId: string,
  planned: Plan,
  mimes: ReadonlyMap<string, string>,
): Promise<PromoteResult | "again"> {
  const prefix = deps.blobs?.prefix ?? "";
  return withTeam(deps.db, owner.teamId, async (tx) => {
    // The Delete's own locks (legal hold, then the workspace), then the plan again.
    await lockLegalHolds(tx);
    await lockWorkspace(tx, owner);
    const again = await plan(tx, { limits: deps.limits, prefix }, owner, request.path, projectId);
    if ("status" in again) return again;
    if (again.fingerprint !== planned.fingerprint) return "again";
    if (again.copies.some((c) => !mimes.has(c.sha256))) return "again";
    await lockTeamStorage(tx, owner.teamId);
    const over = await overLimit(
      tx,
      owner.teamId,
      deps.limits,
      sumSizes(again.copies),
      again.copies.length,
    );
    if (over !== undefined) return refused("quota_exceeded", { limit: over });
    const tree = new Map<string, TreeFile>();
    for (const [path, f] of again.files) {
      tree.set(path, { ...f, mime: mimes.get(f.sha256) ?? "application/octet-stream" });
    }
    try {
      return await tx.transaction(async (sp): Promise<PromoteResult> => {
        const created = await createProject(sp, owner, { name: request.name }, { id: projectId });
        if (!created.ok) return refused("slug_taken");
        await writeCommit(sp, {
          teamId: owner.teamId,
          projectId,
          tree,
          author: { userId: owner.userId, kind: "user" },
          message: promotedFolderMessage(request.path),
        });
        // Only now that the project and its commit exist does the folder leave My files.
        await deleteWorkspaceFiles(sp, sync, owner, again.live);
        return { status: "created", project: created.value.row };
      });
    } catch (err) {
      if (isLegalHoldViolation(err)) return refused("legal_hold");
      throw err;
    }
  });
}

import { Transform, type TransformCallback } from "node:stream";
import { isLegalHoldViolation, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { PROJECT_FILE_MAX_BYTES, PROJECT_FILES_MAX, workspacePathSchema } from "@kobe/protocol";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import type { BlobStore } from "../retention/blobs.js";
import { resolveMime, SNIFF_BYTES } from "../uploads/mime.js";
import { lockTeamStorage } from "../uploads/quota.js";
import { verifyingStream, type ObjectStore } from "../workspace-sync/object-store.js";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";
import { lockWorkspace } from "../workspace-sync/store.js";
import { loadAccess, viewableBy } from "./access.js";
import { findCheckout, folderOf, workingCopy, type CheckoutRow } from "./checkouts.js";
import type { ProjectMounts } from "./mounts.js";
import { overLimit, type TeamLimits } from "./storage.js";
import {
  diffHash,
  diffVersions,
  headOf,
  isProjectKey,
  loadTree,
  projectBlobKey,
  queueProjectBlobs,
  writeCommit,
  type Change,
  type CommitAuthor,
  type TreeFile,
} from "./tree.js";

/**
 * CM5 Commit (KOBE-579): the member's working copy becomes the project's next head. In three
 * steps, so no transaction is held while bytes move:
 *  1. plan (read): access (edit), checkout, head = base (else `commit_conflict`), the diff of the
 *     member's live rows under `projects/<slug>/` against the base tree, the limits, and which
 *     contents the project does not hold yet;
 *  2. copy (no transaction): each missing content from the member's own object (or the project's)
 *     to `teams/<t>/projects/<p>/blobs/<sha256>`, streamed through a hash and size check; the key
 *     is reserved in `retention_blob_deletions` first (due in hours), so a crash leaves nothing
 *     the blob deleter will not take;
 *  3. write (project row lock, then the member's workspace lock, CM9): plan again; the same diff
 *     and every content copied, else back to 2; the team byte quota and object budget under the
 *     team storage lock (`quota_exceeded {limit}`); the commit, its tree, `project_files`, the
 *     checkout's base, the counters, `project.committed`.
 * Other mounted members are reconciled after the transaction, in the background (CM9).
 * Source keys come from the manifest the server wrote (never from a request) and must lie in the
 * member's own tree or the project's; destination keys from verified ids and the hash only.
 */

export interface CommitDeps {
  readonly db: KobeDb;
  readonly blobs: BlobStore | undefined;
  /** Reconciles other mounted members after a commit; absent in tests without workspaces. */
  readonly mounts: Pick<ProjectMounts, "reconcileProject" | "workspace"> | undefined;
  readonly limits: TeamLimits & { readonly maxFileBytes: number };
  readonly log: Pick<Logger, "warn" | "error">;
}

export type CommitRefusal =
  | "not_found"
  | "forbidden"
  | "checkout_required"
  | "archived"
  | "too_many_files"
  | "file_too_large"
  | "conflict_file"
  | "invalid_path"
  | "quota_exceeded"
  | "legal_hold"
  | "changed"
  | "storage_failed";

export type CommitResult =
  | { readonly status: "committed"; readonly seq: number; readonly commitId: string }
  | { readonly status: "nothing_to_commit" }
  | { readonly status: "commit_conflict"; readonly headSeq: number }
  | {
      readonly status: "refused";
      readonly error: CommitRefusal;
      /** The file a path or size refusal names (shown to the member and the model). */
      readonly path?: string;
      readonly limit?: "bytes" | "objects";
    };

export interface CommitRequest {
  readonly owner: WorkspaceOwner;
  readonly projectId: string;
  readonly message: string;
  readonly author: CommitAuthor;
  /** An approved agent commit (CM6): the working copy must still be exactly this. */
  readonly expect?: { readonly baseSeq: number | null; readonly diffHash: string };
}

export interface Copy {
  readonly sha256: string;
  readonly size: number;
  readonly source: string;
  readonly key: string;
}

interface Plan {
  readonly checkout: CheckoutRow;
  readonly slug: string;
  readonly changes: readonly Change[];
  readonly hash: string;
  /** Path -> file, with `mime` undefined for contents still to copy. */
  readonly files: ReadonlyMap<string, Omit<TreeFile, "mime"> & { readonly mime?: string }>;
  /** Path -> the object the member's row names now (repointed to the project's after a commit). */
  readonly sources: ReadonlyMap<string, string>;
  readonly copies: readonly Copy[];
}

const refused = (
  error: CommitRefusal,
  extra: { path?: string; limit?: "bytes" | "objects" } = {},
): CommitResult => ({ status: "refused", error, ...extra });

/** Contents the project already holds, by hash: a key and its mime type. */
async function heldContents(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  hashes: readonly string[],
): Promise<Map<string, { blobRef: string; mime: string }>> {
  if (hashes.length === 0) return new Map();
  const res = await tx.execute<{ sha256: string; blob_ref: string; mime_type: string }>(sql`
    SELECT DISTINCT ON (sha256) sha256, blob_ref, mime_type FROM (
      SELECT e.sha256, e.blob_ref, e.mime_type FROM project_tree_entries e
        JOIN project_commits c ON c.team_id = e.team_id AND c.id = e.commit_id
       WHERE e.team_id = ${teamId} AND c.project_id = ${projectId} AND e.sha256 IN ${hashes}
      UNION ALL
      SELECT sha256, blob_ref, mime_type FROM project_files
       WHERE team_id = ${teamId} AND project_id = ${projectId} AND sha256 IN ${hashes}) h
     ORDER BY sha256, blob_ref`);
  return new Map(res.rows.map((r) => [r.sha256, { blobRef: r.blob_ref, mime: r.mime_type }]));
}

const isConflictName = (path: string): boolean =>
  path.slice(path.lastIndexOf("/") + 1).includes(".conflict-");

/** Step 1 (and again in step 3): see the module header. */
export async function planCommit(
  tx: KobeTx,
  deps: Pick<CommitDeps, "blobs" | "limits">,
  req: Pick<CommitRequest, "owner" | "projectId" | "expect">,
  options: { lock?: boolean } = {},
): Promise<Plan | CommitResult> {
  const { owner, projectId } = req;
  const access = await loadAccess(tx, owner, projectId, { lock: options.lock === true });
  if (!access) return refused("not_found");
  if (!access.can.edit) return refused("forbidden");
  if (access.project.archivedAt !== null) return refused("archived");
  const checkout = await findCheckout(tx, owner.teamId, projectId, owner.userId);
  if (!checkout) return refused("checkout_required");
  if (options.lock) await lockWorkspace(tx, owner);
  const head = await headOf(tx, owner.teamId, projectId);
  if ((head?.id ?? null) !== checkout.baseCommitId && head !== null) {
    return { status: "commit_conflict", headSeq: head.seq };
  }
  const work = await workingCopy(tx, owner, access.project.slug);
  const changes = diffVersions(await loadTree(tx, owner.teamId, checkout.baseCommitId), work);
  const hash = diffHash(changes);
  if (req.expect && (req.expect.baseSeq !== checkout.baseSeq || req.expect.diffHash !== hash)) {
    return refused("changed");
  }
  if (changes.length === 0) return { status: "nothing_to_commit" };
  if (work.size > PROJECT_FILES_MAX) return refused("too_many_files");
  const maxBytes = Math.min(PROJECT_FILE_MAX_BYTES, deps.limits.maxFileBytes);
  for (const [path, file] of work) {
    if (!workspacePathSchema.safeParse(path).success) return refused("invalid_path", { path });
    if (file.size > maxBytes) return refused("file_too_large", { path });
  }
  // A conflict copy is refused only where this commit adds or changes it (an older head file with
  // such a name stays committable around).
  for (const change of changes) {
    if (change.change !== "deleted" && isConflictName(change.path)) {
      return refused("conflict_file", { path: change.path });
    }
  }
  const held = await heldContents(tx, owner.teamId, projectId, [
    ...new Set([...work.values()].map((f) => f.sha256)),
  ]);
  const prefix = deps.blobs?.prefix ?? "";
  const files = new Map<string, Omit<TreeFile, "mime"> & { mime?: string }>();
  const copies = new Map<string, Copy>();
  const sources = new Map<string, string>();
  const allowed = await sourceCheck(
    tx,
    prefix,
    owner,
    [...work.values()].map((f) => f.blobKey),
  );
  for (const [path, file] of work) {
    sources.set(path, file.blobKey);
    const have = held.get(file.sha256);
    if (have) {
      files.set(path, { ...pick(path, file), blobRef: have.blobRef, mime: have.mime });
      continue;
    }
    const source = file.blobKey;
    if (!allowed(source)) return refused("storage_failed", { path });
    const key = projectBlobKey(prefix, owner.teamId, projectId, file.sha256);
    copies.set(file.sha256, { sha256: file.sha256, size: file.size, source, key });
    files.set(path, { ...pick(path, file), blobRef: key });
  }
  return {
    checkout,
    slug: access.project.slug,
    changes,
    hash,
    files,
    sources,
    copies: [...copies.values()],
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Which source keys a commit may copy from: the member's own tree, the workspace's thread-upload
 * tree, or the tree of any project of the workspace the member may view (a file moved between
 * checkouts keeps its object). Never another member's tree or another workspace's; the hash and
 * size are verified on the copy whatever the source.
 */
export async function sourceCheck(
  tx: KobeTx,
  prefix: string,
  owner: WorkspaceOwner,
  keys: readonly string[],
): Promise<(key: string) => boolean> {
  const team = `${prefix}teams/${owner.teamId}/`;
  const projectOf = (key: string): string | undefined => {
    if (!key.startsWith(`${team}projects/`)) return undefined;
    const id = key.slice(`${team}projects/`.length).split("/")[0] ?? "";
    return UUID.test(id) && isProjectKey(prefix, owner.teamId, id, key) ? id : undefined;
  };
  const ids = [...new Set(keys.map(projectOf).filter((id): id is string => id !== undefined))];
  const viewable = new Set<string>();
  if (ids.length > 0) {
    const res = await tx.execute<{ id: string }>(sql`
      SELECT p.id FROM projects p
       WHERE p.team_id = ${owner.teamId} AND p.id IN ${ids} AND ${viewableBy(owner.userId)}`);
    for (const r of res.rows) viewable.add(r.id);
  }
  const clean = (key: string, tree: string) =>
    key.startsWith(tree) &&
    key.length <= 1024 &&
    !key
      .slice(tree.length)
      .split("/")
      .some((p) => p === "" || p === "." || p === "..");
  return (key) => {
    if (clean(key, `${team}users/${owner.userId}/`) || clean(key, `${team}uploads/`)) return true;
    const id = projectOf(key);
    return id !== undefined && viewable.has(id);
  };
}

const pick = (path: string, f: { sha256: string; size: number; executable: boolean }) => ({
  path,
  sha256: f.sha256,
  size: f.size,
  executable: f.executable,
});

/** Thrown when a source object is missing or fails its hash/size check. */
export class CopyFailed extends Error {}

/**
 * Copies `from` to `to` through a hash and size check (the store never completes an object whose
 * bytes do not match), and returns the first bytes for the mime type.
 */
export async function copyVerified(objects: ObjectStore, copy: Copy): Promise<Uint8Array> {
  const source = await objects.get(copy.source);
  if (!source) throw new CopyFailed("source object missing");
  const head: Buffer[] = [];
  let seen = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      if (seen < SNIFF_BYTES) head.push(chunk.subarray(0, SNIFF_BYTES - seen));
      seen += chunk.length;
      done(null, chunk);
    },
  });
  const verified = verifyingStream(copy.sha256, copy.size);
  source.body.once("error", (err) => verified.destroy(err));
  tap.once("error", (err) => verified.destroy(err));
  source.body.pipe(tap).pipe(verified);
  try {
    await objects.put(copy.key, verified, copy.size);
  } catch (err) {
    source.body.destroy();
    throw new CopyFailed(err instanceof Error ? err.message : "copy failed");
  }
  return Buffer.concat(head);
}

const MAX_ROUNDS = 3;

/** Steps 2 and 3 for a plan: see the module header. */
export async function commitWorkingCopy(
  deps: CommitDeps,
  req: CommitRequest,
): Promise<CommitResult> {
  const { owner, projectId } = req;
  const mimes = new Map<string, string>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const plan = await withTeam(deps.db, owner.teamId, (tx) => planCommit(tx, deps, req));
    if (!("files" in plan)) return plan;
    const missing = plan.copies.filter((c) => !mimes.has(c.sha256));
    if (missing.length > 0) {
      const blobs = deps.blobs;
      if (!blobs) return refused("storage_failed");
      // Fail fast on the quota before moving bytes (the write step checks again under the lock).
      const early = await withTeam(deps.db, owner.teamId, (tx) =>
        overLimit(tx, owner.teamId, deps.limits, sumSizes(plan.copies), plan.copies.length),
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
          deps.log.warn({ err, team_id: owner.teamId }, "project commit: a copy failed");
          return refused("storage_failed");
        }
      }
    }
    const written = await writeStep(deps, req, mimes);
    if (written !== "again") {
      if (written.status === "committed") {
        // CM9: other mounted members see the new head; never inside the commit's transaction.
        void deps.mounts?.reconcileProject(owner.teamId, projectId).catch(() => undefined);
      }
      return written;
    }
  }
  return refused("changed");
}

/**
 * After a commit the member's rows name the project's copy of each file (same content), so the
 * content is not stored and counted twice: their own objects are released to collection and the
 * row counts 0 against their scratchspace (the project counts it). Under the workspace lock.
 */
async function repointRows(
  tx: KobeTx,
  deps: CommitDeps,
  owner: WorkspaceOwner,
  plan: Plan,
  tree: ReadonlyMap<string, TreeFile>,
): Promise<void> {
  const writer = deps.mounts?.workspace;
  if (!writer) return;
  for (const [path, file] of tree) {
    if (plan.sources.get(path) === file.blobRef) continue;
    await writer.putServerFile(
      tx,
      owner,
      {
        path: `${folderOf(plan.slug)}${path}`,
        sha256: file.sha256,
        size: file.size,
        blobKey: file.blobRef,
        executable: file.executable,
      },
      "projects",
    );
  }
}

const sumSizes = (copies: readonly Copy[]): number => copies.reduce((n, c) => n + c.size, 0);

async function writeStep(
  deps: CommitDeps,
  req: CommitRequest,
  mimes: ReadonlyMap<string, string>,
): Promise<CommitResult | "again"> {
  const { owner, projectId } = req;
  return withTeam(deps.db, owner.teamId, async (tx) => {
    const plan = await planCommit(tx, deps, req, { lock: true });
    if (!("files" in plan)) return plan;
    if (plan.copies.some((c) => !mimes.has(c.sha256))) return "again";
    await lockTeamStorage(tx, owner.teamId);
    const over = await overLimit(
      tx,
      owner.teamId,
      deps.limits,
      sumSizes(plan.copies),
      plan.copies.length,
    );
    if (over !== undefined) return refused("quota_exceeded", { limit: over });
    const tree = new Map<string, TreeFile>();
    for (const [path, f] of plan.files) {
      tree.set(path, { ...f, mime: f.mime ?? mimes.get(f.sha256) ?? "application/octet-stream" });
    }
    try {
      const written = await tx.transaction(async (sp) => {
        const commit = await writeCommit(sp, {
          teamId: owner.teamId,
          projectId,
          tree,
          author: req.author,
          message: req.message,
        });
        await sp.execute(sql`
          UPDATE project_checkouts SET base_commit_id = ${commit.commitId}, updated_at = now()
           WHERE team_id = ${owner.teamId} AND project_id = ${projectId}
             AND user_id = ${owner.userId}`);
        await repointRows(sp, deps, owner, plan, tree);
        return commit;
      });
      return { status: "committed", seq: written.seq, commitId: written.commitId };
    } catch (err) {
      if (isLegalHoldViolation(err)) return refused("legal_hold");
      throw err;
    }
  });
}

/** Read-only preview for an agent's approval (CM6): base seq and diff hash, or the answer now. */
export async function previewCommit(
  deps: Pick<CommitDeps, "db" | "blobs" | "limits">,
  req: Pick<CommitRequest, "owner" | "projectId">,
): Promise<{ readonly baseSeq: number | null; readonly diffHash: string } | CommitResult> {
  const plan = await withTeam(deps.db, req.owner.teamId, (tx) => planCommit(tx, deps, req));
  if (!("files" in plan)) return plan;
  return { baseSeq: plan.checkout.baseSeq, diffHash: plan.hash };
}

/**
 * CM7 Revert (editor+): a new commit whose tree is the tree at `seq` (append-only). Its objects
 * are all held already, so no copy and no quota check. Audited `project.commit_reverted`.
 */
export async function revertTo(
  deps: Pick<CommitDeps, "db" | "mounts">,
  owner: WorkspaceOwner,
  projectId: string,
  seq: number,
  message: string | undefined,
): Promise<CommitResult | { readonly status: "commit_not_found" }> {
  const result = await withTeam(
    deps.db,
    owner.teamId,
    async (tx): Promise<CommitResult | { status: "commit_not_found" }> => {
      const access = await loadAccess(tx, owner, projectId, { lock: true });
      if (!access) return refused("not_found");
      if (!access.can.edit) return refused("forbidden");
      if (access.project.archivedAt !== null) return refused("archived");
      const target = await tx.execute<{ id: string }>(sql`
        SELECT id FROM project_commits
         WHERE team_id = ${owner.teamId} AND project_id = ${projectId} AND seq = ${seq}`);
      const id = target.rows[0]?.id;
      if (id === undefined) return { status: "commit_not_found" };
      const tree = await loadTree(tx, owner.teamId, id);
      const head = await headOf(tx, owner.teamId, projectId);
      if (diffVersions(await loadTree(tx, owner.teamId, head?.id ?? null), tree).length === 0) {
        return { status: "nothing_to_commit" };
      }
      try {
        const written = await tx.transaction((sp) =>
          writeCommit(sp, {
            teamId: owner.teamId,
            projectId,
            tree,
            author: { userId: owner.userId, kind: "user" },
            message: message ?? `Revert to #${seq}`,
            audit: false,
          }),
        );
        await recordAudit(tx, {
          action: "project.commit_reverted",
          actor: { kind: "user", id: owner.userId },
          teamId: owner.teamId,
          target: { projectId, commitId: written.commitId, seq: written.seq, revertedSeq: seq },
        });
        return { status: "committed", seq: written.seq, commitId: written.commitId };
      } catch (err) {
        if (isLegalHoldViolation(err)) return refused("legal_hold");
        throw err;
      }
    },
  );
  if (result.status === "committed") {
    void deps.mounts?.reconcileProject(owner.teamId, projectId).catch(() => undefined);
  }
  return result;
}

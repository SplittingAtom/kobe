import { sql, type KobeTx } from "@kobe/db";
import {
  PROJECT_WORKSPACE_DIR,
  type ProjectCheckout,
  type ProjectDiffEntry,
  type UpdateCheckoutResponse,
} from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";
import type { ServerWriteArea, StoredEntry } from "../workspace-sync/store.js";
import { currentEntry, listLive, lockWorkspace } from "../workspace-sync/store.js";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";
import type { ProjectMounts } from "./mounts.js";
import type { ProjectRow } from "./access.js";
import {
  diffVersions,
  headOf,
  loadTree,
  toDiffEntries,
  type Change,
  type Tree,
  type TreeFile,
  type Version,
} from "./tree.js";

/**
 * A member's working copy of a project (KOBE-579, Workspaces CM2, CM3, CM5 Update and Discard).
 * The working copy is the member's own manifest rows under `projects/<slug>/` (no copy: the rows
 * keep pointing at the project's objects until the member changes a file). Mount reconcile skips
 * a checked-out folder (KOBE-578), so these functions write it themselves. Every function runs in
 * the caller's team transaction, which holds the project row lock (`loadAccess(..., { lock:
 * true })`); the member's workspace lock is taken here, after it (CM9 order).
 */

/** What the server writes into workspaces (`WorkspaceSync.putServerFile`/`deleteServerFile`). */
export interface WorkspaceWriter {
  readonly prefix: string;
  putServerFile(
    tx: KobeTx,
    owner: WorkspaceOwner,
    file: {
      path: string;
      sha256: string;
      size: number;
      blobKey: string;
      executable?: boolean;
    },
    area: ServerWriteArea,
  ): Promise<StoredEntry>;
  deleteServerFile(tx: KobeTx, owner: WorkspaceOwner, path: string): Promise<unknown>;
}

const AREA = `${PROJECT_WORKSPACE_DIR}/`;
/** More rows than one project folder may hold (500 files plus a member's additions). */
const FOLDER_LIMIT = 50_000;

export const folderOf = (slug: string): string => `${AREA}${slug}/`;

export interface WorkingFile extends Version {
  readonly blobKey: string;
  readonly origin: "sandbox" | "server";
}

/** The member's live rows under the project folder, by path relative to it. */
export async function workingCopy(
  tx: KobeTx,
  owner: WorkspaceOwner,
  slug: string,
): Promise<Map<string, WorkingFile>> {
  const dir = folderOf(slug);
  const rows = await listLive(tx, owner, dir, FOLDER_LIMIT);
  const out = new Map<string, WorkingFile>();
  for (const r of rows) {
    if (r.sha256 === undefined || r.blobKey === null) continue;
    out.set(r.path.slice(dir.length), {
      sha256: r.sha256,
      size: r.size,
      executable: r.executable,
      blobKey: r.blobKey,
      origin: r.origin,
    });
  }
  return out;
}

export interface CheckoutRow {
  readonly projectId: string;
  readonly userId: string;
  readonly baseCommitId: string | null;
  readonly baseSeq: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type RawCheckout = {
  project_id: string;
  user_id: string;
  base_commit_id: string | null;
  seq: number | null;
  slug: string;
  created_at: Date | string;
  updated_at: Date | string;
};

const toRow = (r: RawCheckout): CheckoutRow => ({
  projectId: r.project_id,
  userId: r.user_id,
  baseCommitId: r.base_commit_id,
  baseSeq: r.seq === null ? null : Number(r.seq),
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
});

const toProtocol = (r: RawCheckout): ProjectCheckout => ({
  project_id: r.project_id,
  slug: r.slug,
  base_commit_id: r.base_commit_id,
  base_commit_seq: r.seq === null ? null : Number(r.seq),
  created_at: new Date(r.created_at).toISOString(),
  updated_at: new Date(r.updated_at).toISOString(),
});

const SELECT_CHECKOUTS = sql`
  SELECT c.project_id, c.user_id, c.base_commit_id, b.seq, p.slug, c.created_at, c.updated_at
    FROM project_checkouts c
    JOIN projects p ON p.team_id = c.team_id AND p.id = c.project_id
    LEFT JOIN project_commits b ON b.team_id = c.team_id AND b.id = c.base_commit_id`;

async function readCheckout(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  userId: string,
): Promise<RawCheckout | undefined> {
  const res = await tx.execute<RawCheckout>(sql`${SELECT_CHECKOUTS}
     WHERE c.team_id = ${teamId} AND c.project_id = ${projectId} AND c.user_id = ${userId}`);
  return res.rows[0];
}

export async function findCheckout(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  userId: string,
): Promise<CheckoutRow | undefined> {
  const row = await readCheckout(tx, teamId, projectId, userId);
  return row ? toRow(row) : undefined;
}

/** `GET /v1/me/checkouts`: the caller's checkouts in the active workspace. */
export async function myCheckouts(tx: KobeTx, owner: WorkspaceOwner): Promise<ProjectCheckout[]> {
  const res = await tx.execute<RawCheckout>(sql`${SELECT_CHECKOUTS}
     WHERE c.team_id = ${owner.teamId} AND c.user_id = ${owner.userId} ORDER BY p.slug`);
  return res.rows.map(toProtocol);
}

/** `GET /v1/projects/:id/checkouts` (owners, team admins): "Working copies". */
export async function projectCheckouts(
  tx: KobeTx,
  teamId: string,
  projectId: string,
): Promise<(ProjectCheckout & { user_id: string })[]> {
  const res = await tx.execute<RawCheckout>(sql`${SELECT_CHECKOUTS}
     WHERE c.team_id = ${teamId} AND c.project_id = ${projectId} ORDER BY c.created_at, c.user_id`);
  return res.rows.map((r) => ({ ...toProtocol(r), user_id: r.user_id }));
}

/** The object tree an object key lies in, for `putServerFile`'s ownership check. */
function areaOfKey(prefix: string, owner: WorkspaceOwner, key: string): ServerWriteArea {
  if (key.startsWith(`${prefix}teams/${owner.teamId}/projects/`)) return "projects";
  if (key.startsWith(`${prefix}teams/${owner.teamId}/uploads/`)) return "uploads";
  return "user";
}

async function putHead(
  tx: KobeTx,
  writer: WorkspaceWriter,
  owner: WorkspaceOwner,
  path: string,
  file: TreeFile,
): Promise<void> {
  await writer.putServerFile(
    tx,
    owner,
    {
      path,
      sha256: file.sha256,
      size: file.size,
      blobKey: file.blobRef,
      executable: file.executable,
    },
    "projects",
  );
}

/**
 * Makes the folder exactly `tree` (server rows pointing at the project's objects; tombstones for
 * anything else). Under the workspace lock, which the caller took.
 */
async function writeTreeInto(
  tx: KobeTx,
  writer: WorkspaceWriter,
  owner: WorkspaceOwner,
  slug: string,
  tree: Tree,
): Promise<void> {
  const dir = folderOf(slug);
  const work = await workingCopy(tx, owner, slug);
  for (const [path, file] of tree) {
    const have = work.get(path);
    if (have?.blobKey === file.blobRef && have.executable === file.executable) continue;
    await putHead(tx, writer, owner, `${dir}${path}`, file);
  }
  for (const path of work.keys()) {
    if (!tree.has(path)) await writer.deleteServerFile(tx, owner, `${dir}${path}`);
  }
}

export type CheckoutOutcome =
  | { readonly ok: true; readonly checkout: ProjectCheckout; readonly created: boolean }
  | { readonly ok: false; readonly error: "archived" };

/**
 * CM2 Checkout (editor+, checked by the caller): base = head; idempotent. The folder is the
 * member's from now on: a project that was not mounted gets its head written in; a mounted one
 * keeps its rows (they already are the head). Audited `project.checked_out`.
 */
export async function checkout(
  tx: KobeTx,
  writer: WorkspaceWriter,
  owner: WorkspaceOwner,
  project: ProjectRow,
): Promise<CheckoutOutcome> {
  const existing = await readCheckout(tx, owner.teamId, project.id, owner.userId);
  if (existing) return { ok: true, checkout: toProtocol(existing), created: false };
  if (project.archivedAt !== null) return { ok: false, error: "archived" };
  const head = await headOf(tx, owner.teamId, project.id);
  await tx.execute(sql`
    INSERT INTO project_checkouts (team_id, project_id, user_id, base_commit_id)
    VALUES (${owner.teamId}, ${project.id}, ${owner.userId}, ${head?.id ?? null})`);
  await lockWorkspace(tx, owner);
  await writeTreeInto(
    tx,
    writer,
    owner,
    project.slug,
    await loadTree(tx, owner.teamId, head?.id ?? null),
  );
  await recordAudit(tx, {
    action: "project.checked_out",
    actor: { kind: "user", id: owner.userId },
    teamId: owner.teamId,
    target: { projectId: project.id, baseSeq: head?.seq ?? null },
  });
  const row = await readCheckout(tx, owner.teamId, project.id, owner.userId);
  if (!row) throw new Error("checkout row vanished");
  return { ok: true, checkout: toProtocol(row), created: true };
}

/** The working copy's changes against the checkout's base (the web's "Changes"). */
export async function workingChanges(
  tx: KobeTx,
  owner: WorkspaceOwner,
  slug: string,
  baseCommitId: string | null,
): Promise<Change[]> {
  const base = await loadTree(tx, owner.teamId, baseCommitId);
  return diffVersions(base, await workingCopy(tx, owner, slug));
}

/** `GET /v1/projects/:id/checkout`: the caller's checkout and its diff, or undefined. */
export async function checkoutWithDiff(
  tx: KobeTx,
  owner: WorkspaceOwner,
  projectId: string,
): Promise<(ProjectCheckout & { diff: ProjectDiffEntry[] }) | undefined> {
  const row = await readCheckout(tx, owner.teamId, projectId, owner.userId);
  if (!row) return undefined;
  const changes = await workingChanges(tx, owner, row.slug, row.base_commit_id);
  return { ...toProtocol(row), diff: toDiffEntries(changes) };
}

/**
 * CM5 Discard: the checkout ends and the folder is reconciled like any mount (KOBE-578): back to
 * the head as new server rows plus tombstones while a conversation keeps the project open, gone
 * otherwise. The sandbox relocks it at its next pull (the slug leaves `checkouts`). Audited
 * `project.checkout_discarded {reason: discarded}`. False when there was no checkout.
 */
export async function discard(
  tx: KobeTx,
  mounts: ProjectMounts,
  owner: WorkspaceOwner,
  projectId: string,
): Promise<boolean> {
  const gone = await tx.execute(sql`
    DELETE FROM project_checkouts
     WHERE team_id = ${owner.teamId} AND project_id = ${projectId} AND user_id = ${owner.userId}
    RETURNING 1`);
  if (gone.rows.length === 0) return false;
  await recordAudit(tx, {
    action: "project.checkout_discarded",
    actor: { kind: "user", id: owner.userId },
    teamId: owner.teamId,
    target: { projectId, userId: owner.userId, reason: "discarded" },
  });
  await mounts.reconcileUserIn(tx, owner.teamId, owner.userId);
  return true;
}

/** `<stem>.conflict-YYYYMMDDTHHMMSSZ[-n]<ext>` (D13's rule, `CONFLICT_COPY_PATTERN`). */
export function conflictCopyPath(path: string, at: Date, n: number): string {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return `${dir}${stem}.conflict-${stamp}${n > 1 ? `-${n}` : ""}${ext}`;
}

async function freeConflictPath(
  tx: KobeTx,
  owner: WorkspaceOwner,
  path: string,
  at: Date,
): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const candidate = conflictCopyPath(path, at, n);
    const row = await currentEntry(tx, owner, candidate);
    if (row === undefined || row.deleted) return candidate;
  }
  throw new Error("no free conflict-copy name");
}

const sameVersion = (a: Version | undefined, b: Version | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.sha256 === b.sha256 && a.executable === b.executable;

/**
 * CM5 Update: brings the head's changes into the working copy. A path only the head changed takes
 * the head's version (a server row); a path both changed takes the head's version and the
 * member's edit stays beside it as a conflict copy (listed, as workspace paths). The base moves
 * to the head.
 */
export async function update(
  tx: KobeTx,
  writer: WorkspaceWriter,
  owner: WorkspaceOwner,
  project: ProjectRow,
  row: CheckoutRow,
  now: Date = new Date(),
): Promise<UpdateCheckoutResponse> {
  const head = await headOf(tx, owner.teamId, project.id);
  if (head === null || head.id === row.baseCommitId) {
    return { base_commit_seq: head?.seq ?? row.baseSeq, conflict_paths: [] };
  }
  await lockWorkspace(tx, owner);
  const base = await loadTree(tx, owner.teamId, row.baseCommitId);
  const theirs = await loadTree(tx, owner.teamId, head.id);
  const work = await workingCopy(tx, owner, project.slug);
  const dir = folderOf(project.slug);
  const conflicts: string[] = [];
  for (const change of diffVersions(base, theirs)) {
    const mine = work.get(change.path);
    const target = theirs.get(change.path);
    if (sameVersion(mine, target)) continue;
    if (!sameVersion(mine, base.get(change.path)) && mine !== undefined) {
      // Both changed: the member's edit is kept beside the head's version.
      const copy = await freeConflictPath(tx, owner, `${dir}${change.path}`, now);
      await writer.putServerFile(
        tx,
        owner,
        {
          path: copy,
          sha256: mine.sha256,
          size: mine.size,
          blobKey: mine.blobKey,
          executable: mine.executable,
        },
        areaOfKey(writer.prefix, owner, mine.blobKey),
      );
      conflicts.push(copy);
    }
    if (target) await putHead(tx, writer, owner, `${dir}${change.path}`, target);
    else await writer.deleteServerFile(tx, owner, `${dir}${change.path}`);
  }
  await tx.execute(sql`
    UPDATE project_checkouts SET base_commit_id = ${head.id}, updated_at = now()
     WHERE team_id = ${owner.teamId} AND project_id = ${project.id} AND user_id = ${owner.userId}`);
  return { base_commit_seq: head.seq, conflict_paths: conflicts };
}

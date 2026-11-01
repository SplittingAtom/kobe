import {
  and,
  asc,
  eq,
  inArray,
  pgErrorOf,
  sql,
  threadFolders,
  threads,
  type KobeTx,
} from "@kobe/db";
import { THREAD_FOLDERS_MAX, type ThreadFolder, type ThreadFolderErrorCode } from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";
import type { RateLimitRule } from "../rate-limit.js";
import { folderThreadCounts, type Viewer } from "./repository.js";

/**
 * The team's thread folders (KOBE-534, spec TF1, TF4, TF11). Every member of the team sees every
 * folder and may create, rename, move and delete one (no folder owner; `created_by` is for the
 * audit trail). Each change is audited as a team event; a position change alone is not.
 *
 * The tree's shape (at most three levels, no cycles) is the database's: trigger
 * `thread_folders_guard_parent` raises KF001 (too deep) or KF002 (cycle), and the sibling-name
 * key `thread_folders_name_unique` 23505. The route maps them with {@link folderErrorOf} after the
 * transaction rolled back, so a refused change leaves neither a row nor an audit entry behind.
 */

/** Folder creation per member (TF4, §6): as fork's. */
export const FOLDER_CREATE_RATE: RateLimitRule = { windowMs: 10 * 60_000, max: 60 };

export type FolderError = Extract<
  ThreadFolderErrorCode,
  "folder_not_found" | "folder_name_taken" | "folder_too_deep" | "folder_cycle" | "folder_limit"
>;

export type FolderResult<T> = { ok: true; value: T } | { ok: false; error: FolderError };

/** The trigger's and the name key's refusals, as the route's error codes. */
export function folderErrorOf(err: unknown): FolderError | undefined {
  const pg = pgErrorOf(err);
  if (pg?.code === "KF001") return "folder_too_deep";
  if (pg?.code === "KF002") return "folder_cycle";
  if (pg?.code === "23505" && pg.constraint === "thread_folders_name_unique") {
    return "folder_name_taken";
  }
  return undefined;
}

/**
 * Serializes the team's folder changes: the same transaction-level advisory lock the tree trigger
 * takes, so the folder count (THREAD_FOLDERS_MAX) and a delete's subtree are read stable.
 */
async function lockTree(tx: KobeTx, teamId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kobe.thread_folders:${teamId}`}, 0))`,
  );
}

const folderColumns = {
  id: threadFolders.id,
  parentId: threadFolders.parentId,
  name: threadFolders.name,
  position: threadFolders.position,
  createdBy: threadFolders.createdBy,
};

type FolderRow = {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly position: number;
  readonly createdBy: string;
};

const toFolder = (row: FolderRow, threadCount: number): ThreadFolder => ({
  id: row.id,
  parent_id: row.parentId,
  name: row.name,
  position: row.position,
  created_by: row.createdBy,
  threads: threadCount,
});

/** Every folder of the team (at most 500), with the viewer's own count of each (TF4, TF5). */
export async function listFolders(tx: KobeTx, viewer: Viewer): Promise<ThreadFolder[]> {
  const rows = await tx
    .select(folderColumns)
    .from(threadFolders)
    .where(eq(threadFolders.teamId, viewer.teamId))
    // Top-level folders first, then by parent; siblings by position, ties by name (TF1).
    .orderBy(
      sql`${threadFolders.parentId} ASC NULLS FIRST`,
      asc(threadFolders.position),
      asc(threadFolders.name),
    );
  const counts = await folderThreadCounts(tx, viewer);
  return rows.map((r) => toFolder(r, counts.get(r.id) ?? 0));
}

async function findFolder(
  tx: KobeTx,
  teamId: string,
  id: string,
  lock: "update" | "key share",
): Promise<FolderRow | undefined> {
  const [row] = await tx
    .select(folderColumns)
    .from(threadFolders)
    .where(and(eq(threadFolders.teamId, teamId), eq(threadFolders.id, id)))
    .for(lock);
  return row;
}

/** A new folder, at the top level or under `parentId` (TF4). */
export async function createFolder(
  tx: KobeTx,
  viewer: Viewer,
  input: { readonly name: string; readonly parentId: string | null },
): Promise<FolderResult<ThreadFolder>> {
  await lockTree(tx, viewer.teamId);
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(threadFolders)
    .where(eq(threadFolders.teamId, viewer.teamId));
  if ((count?.n ?? 0) >= THREAD_FOLDERS_MAX) return { ok: false, error: "folder_limit" };
  if (
    input.parentId !== null &&
    !(await findFolder(tx, viewer.teamId, input.parentId, "key share"))
  ) {
    return { ok: false, error: "folder_not_found" };
  }
  const [row] = await tx
    .insert(threadFolders)
    .values({
      teamId: viewer.teamId,
      parentId: input.parentId,
      name: input.name,
      createdBy: viewer.userId,
    })
    .returning(folderColumns);
  if (!row) throw new Error("folder insert returned no row");
  await recordAudit(tx, {
    action: "thread_folder.created",
    teamId: viewer.teamId,
    target: { folderId: row.id, name: row.name, parentId: row.parentId },
  });
  return { ok: true, value: toFolder(row, 0) };
}

/** Rename, move (`parentId: null` = top level) or reorder a folder (TF4). */
export async function updateFolder(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  change: {
    readonly name?: string | undefined;
    readonly parentId?: string | null | undefined;
    readonly position?: number | undefined;
  },
): Promise<FolderResult<ThreadFolder>> {
  const before = await findFolder(tx, viewer.teamId, id, "update");
  if (!before) return { ok: false, error: "folder_not_found" };
  const renamed = change.name !== undefined && change.name !== before.name;
  const moved = change.parentId !== undefined && change.parentId !== before.parentId;
  const reordered = change.position !== undefined && change.position !== before.position;
  if (
    moved &&
    change.parentId != null &&
    !(await findFolder(tx, viewer.teamId, change.parentId, "key share"))
  ) {
    return { ok: false, error: "folder_not_found" };
  }
  let row: FolderRow = before;
  if (renamed || moved || reordered) {
    const [updated] = await tx
      .update(threadFolders)
      .set({
        ...(renamed ? { name: change.name } : {}),
        ...(moved ? { parentId: change.parentId ?? null } : {}),
        ...(reordered ? { position: change.position } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(threadFolders.teamId, viewer.teamId), eq(threadFolders.id, id)))
      .returning(folderColumns);
    if (!updated) throw new Error("folder update returned no row");
    row = updated;
  }
  if (renamed) {
    await recordAudit(tx, {
      action: "thread_folder.renamed",
      teamId: viewer.teamId,
      target: { folderId: id, from: before.name, to: row.name },
    });
  }
  if (moved) {
    await recordAudit(tx, {
      action: "thread_folder.moved",
      teamId: viewer.teamId,
      target: { folderId: id, from: before.parentId, to: row.parentId },
    });
  }
  const counts = await folderThreadCounts(tx, viewer);
  return { ok: true, value: toFolder(row, counts.get(id) ?? 0) };
}

/**
 * Deletes the folder and its subfolders (the key's cascade); their threads' `folder_id` is nulled
 * (they go back to their owners' Current). Audited with what it took along.
 */
export async function deleteFolder(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
): Promise<FolderResult<null>> {
  await lockTree(tx, viewer.teamId);
  const folder = await findFolder(tx, viewer.teamId, id, "update");
  if (!folder) return { ok: false, error: "folder_not_found" };
  const subtree = await tx.execute<{ id: string }>(sql`
    WITH RECURSIVE sub(id, level) AS (
      SELECT f.id, 1 FROM thread_folders f WHERE f.team_id = ${viewer.teamId} AND f.id = ${id}
      UNION ALL
      SELECT f.id, s.level + 1 FROM thread_folders f
        JOIN sub s ON f.team_id = ${viewer.teamId} AND f.parent_id = s.id
       WHERE s.level < 10
    )
    SELECT id FROM sub`);
  const ids = subtree.rows.map((r) => r.id);
  // The whole subtree before any thread: filing holds its folder, then the thread, in that order.
  await tx
    .select({ id: threadFolders.id })
    .from(threadFolders)
    .where(and(eq(threadFolders.teamId, viewer.teamId), inArray(threadFolders.id, ids)))
    .for("update");
  const [filed] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(threads)
    .where(and(eq(threads.teamId, viewer.teamId), inArray(threads.folderId, ids)));
  await tx
    .delete(threadFolders)
    .where(and(eq(threadFolders.teamId, viewer.teamId), eq(threadFolders.id, id)));
  await recordAudit(tx, {
    action: "thread_folder.deleted",
    teamId: viewer.teamId,
    target: { folderId: id, name: folder.name, folders: ids.length - 1, threads: filed?.n ?? 0 },
  });
  return { ok: true, value: null };
}

/** Whether the folder exists in the team, holding it against deletion until commit. */
export async function holdFolder(tx: KobeTx, teamId: string, folderId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: threadFolders.id })
    .from(threadFolders)
    .where(and(eq(threadFolders.teamId, teamId), eq(threadFolders.id, folderId)))
    .for("key share");
  return row !== undefined;
}

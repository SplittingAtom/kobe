import { endThreadRules } from "../policy/user-rules.js";
import { and, eq, sql, threads, type KobeTx, type ThreadProjectMove } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { notifyThreadAccess } from "../event-stream/access.js";
import { canCreateInProject } from "./references.js";
import { holdFolder } from "./folders.js";
import { movesOf, withMove } from "./project-moves.js";
import {
  hasRunIn,
  lockForChange,
  lockForFiling,
  PENDING_RUN_STATUSES,
  summarizeOne,
  summaryColumns,
  type SummaryRow,
  type ThreadResult,
  type Viewer,
} from "./repository.js";

/**
 * The owner's organization of their threads (CE19, KOBE-220): pin, archive, move to project. Each
 * locks the thread like every change (`lockForChange`: owner only, a project reader gets
 * `read_only`), refuses a thread in Trash, and is idempotent. None of them is activity: retention
 * runs from the last message as before (`last_activity_at` is never touched).
 *
 * - Pin and archive are personal: a thread is in at most one of Pinned and Archived (archiving
 *   unpins; pinning an archived thread is refused), and neither is audited, like a rename.
 * - Move sets `project_id` where the owner may start a thread (`canCreateInProject`, as
 *   `POST /v1/threads`), only while no run is queued or running (that run's context is the old
 *   project's), unshares a thread shared to its old project (its audience changes; a team share
 *   stays, KOBE-221), and records
 *   the move for the next run's marker (`project-moves.ts`) and the audit log.
 * - File (KOBE-534, TF3) puts the thread in a team folder or takes it out (`null`). The one change
 *   a D23/CE20 reader may make too (`lockForFiling`); pin, archive, project and shares stay as
 *   they are, and `thread.filed` records who moved it, on a change only.
 */

type Locked = { ok: true; thread: SummaryRow } | Extract<ThreadResult, { ok: false }>;

async function lockOrganizable(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  lock: typeof lockForChange = lockForChange,
): Promise<Locked> {
  const locked = await lock(tx, viewer, id);
  if (!locked.ok) return locked;
  if (locked.thread.deletedAt) return { ok: false, error: "thread_in_trash" };
  // Builder test threads are never listed (KOBE-85): nothing to organize, never in a project.
  if (locked.thread.isTest) return { ok: false, error: "test_thread" };
  return locked;
}

/** Workbench test chats and eval threads are never filed either (`threads_folder_not_test`). */
function isAnyTest(thread: SummaryRow): boolean {
  return thread.isTest || thread.skillTest === true || thread.skillEval === true;
}

type Now = ReturnType<typeof sql>;

/** The columns these changes write (a time is the transaction's `now()`). */
interface Organization {
  readonly pinnedAt?: Now | null;
  readonly archivedAt?: Now | null;
  readonly projectId?: string | null;
  readonly sharedToProject?: boolean;
  readonly projectMoves?: readonly ThreadProjectMove[];
  readonly folderId?: string | null;
}

async function save(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  set: Organization,
): Promise<ThreadResult> {
  const [row] = await tx
    .update(threads)
    .set(set)
    .where(and(eq(threads.teamId, viewer.teamId), eq(threads.id, id)))
    .returning(summaryColumns);
  if (!row) throw new Error("thread update returned no row");
  return { ok: true, thread: await summarizeOne(tx, viewer, row) };
}

const unchanged = async (tx: KobeTx, viewer: Viewer, row: SummaryRow): Promise<ThreadResult> => ({
  ok: true,
  thread: await summarizeOne(tx, viewer, row),
});

export async function setPinned(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  pinned: boolean,
): Promise<ThreadResult> {
  const locked = await lockOrganizable(tx, viewer, id);
  if (!locked.ok) return locked;
  const thread = locked.thread;
  if (pinned && thread.archivedAt) return { ok: false, error: "thread_archived" };
  // Pinning again keeps the first pin time: the Pinned group's order doesn't jump.
  if (pinned === (thread.pinnedAt != null)) return unchanged(tx, viewer, thread);
  return save(tx, viewer, id, { pinnedAt: pinned ? sql`now()` : null });
}

export async function setArchived(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  archived: boolean,
): Promise<ThreadResult> {
  const locked = await lockOrganizable(tx, viewer, id);
  if (!locked.ok) return locked;
  const thread = locked.thread;
  if (archived === (thread.archivedAt != null)) return unchanged(tx, viewer, thread);
  // Archiving ends the thread's remembered approvals for good (KOBE-289 review S2).
  if (archived) await endThreadRules(tx, viewer.teamId, [id]);
  return save(
    tx,
    viewer,
    id,
    archived ? { archivedAt: sql`now()`, pinnedAt: null } : { archivedAt: null },
  );
}

export async function moveThread(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  projectId: string | null,
): Promise<ThreadResult> {
  const locked = await lockOrganizable(tx, viewer, id);
  if (!locked.ok) return locked;
  const thread = locked.thread;
  if (thread.projectId === projectId) return unchanged(tx, viewer, thread);
  if (projectId !== null && !(await canCreateInProject(tx, viewer, projectId))) {
    return { ok: false, error: "project_not_found" };
  }
  if (await hasRunIn(tx, viewer, id, PENDING_RUN_STATUSES)) {
    return { ok: false, error: "thread_busy" };
  }
  // A move ends the thread's remembered approvals for good (KOBE-289 review S2).
  await endThreadRules(tx, viewer.teamId, [id]);
  const { moves, now, started } = await movesOf(tx, viewer.teamId, id);
  const result = await save(tx, viewer, id, {
    projectId,
    sharedToProject: false,
    projectMoves: withMove(moves, {
      at: now,
      from: thread.projectId,
      to: projectId,
      runs: started,
    }),
  });
  await recordAudit(tx, {
    action: "thread.moved",
    teamId: viewer.teamId,
    target: { threadId: id, from: thread.projectId, to: projectId },
  });
  // A project share ends with the move (its readers were the old project's); a team share stays.
  if (thread.sharedToProject && thread.projectId !== null) {
    await recordAudit(tx, {
      action: "thread.sharing_changed",
      teamId: viewer.teamId,
      target: {
        threadId: id,
        projectId: thread.projectId,
        shared: false,
        visibility: "private",
        from: "project",
      },
    });
    await notifyThreadAccess(tx, viewer.teamId, id);
  }
  return result;
}

/**
 * Files the thread in a folder of the team, or takes it out of its folder (`null`). The owner or
 * a reader; refused in Trash and on any test thread; 404 `folder_not_found` for a folder that is
 * not in this team. The folder row is held (KEY SHARE) until commit, so a concurrent delete waits
 * and then nulls this thread like the others. Lock order: folders, then the thread.
 */
export async function fileThread(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  folderId: string | null,
): Promise<ThreadResult> {
  // Folder before thread, as a folder delete locks them (no deadlock with its SET NULL).
  const folderFound = folderId === null || (await holdFolder(tx, viewer.teamId, folderId));
  const locked = await lockOrganizable(tx, viewer, id, lockForFiling);
  if (!locked.ok) return locked;
  const thread = locked.thread;
  if (isAnyTest(thread)) return { ok: false, error: "test_thread" };
  if (!folderFound) return { ok: false, error: "folder_not_found" };
  const from = thread.folderId ?? null;
  if (from === folderId) return unchanged(tx, viewer, thread);
  const result = await save(tx, viewer, id, { folderId });
  await recordAudit(tx, {
    action: "thread.filed",
    teamId: viewer.teamId,
    target: { threadId: id, from, to: folderId },
  });
  return result;
}

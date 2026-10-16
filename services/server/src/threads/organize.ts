import { and, eq, sql, threads, type KobeTx, type ThreadProjectMove } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { notifyThreadAccess } from "../event-stream/access.js";
import { canCreateInProject } from "./references.js";
import { movesOf, withMove } from "./project-moves.js";
import {
  hasRunIn,
  lockForChange,
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
 */

type Locked = { ok: true; thread: SummaryRow } | Extract<ThreadResult, { ok: false }>;

async function lockOrganizable(tx: KobeTx, viewer: Viewer, id: string): Promise<Locked> {
  const locked = await lockForChange(tx, viewer, id);
  if (!locked.ok) return locked;
  if (locked.thread.deletedAt) return { ok: false, error: "thread_in_trash" };
  // Builder test threads are never listed (KOBE-85): nothing to organize, never in a project.
  if (locked.thread.isTest) return { ok: false, error: "test_thread" };
  return locked;
}

type Now = ReturnType<typeof sql>;

/** The columns these changes write (a time is the transaction's `now()`). */
interface Organization {
  readonly pinnedAt?: Now | null;
  readonly archivedAt?: Now | null;
  readonly projectId?: string | null;
  readonly sharedToProject?: boolean;
  readonly projectMoves?: readonly ThreadProjectMove[];
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

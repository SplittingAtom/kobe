import type { ThreadVisibility } from "@kobe/protocol";
import {
  and,
  eq,
  listMemberships,
  sql,
  SYSTEM_ACTOR,
  threads,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { notifyThreadAccess } from "../event-stream/access.js";
import { canCreateInProject } from "./references.js";
import { narrows, shareColumnsFor, visibilityOf, type ShareColumns } from "./share.js";
import type { SummaryRow, ThreadError, Viewer } from "./repository.js";

/**
 * Changing a thread's share scope (D23, CE20, KOBE-221), for its owner: what a change may not do,
 * the columns it writes and what it records. The caller holds the thread row lock
 * (`lockForChange`) and has refused Trash.
 */

/** Why `thread` can't move to `target`, or null. Revoking (`private`) is always allowed. */
export async function shareScopeRefusal(
  tx: KobeTx,
  viewer: Viewer,
  thread: SummaryRow,
  target: ThreadVisibility,
): Promise<ThreadError | null> {
  if (target === visibilityOf(thread) || target === "private") return null;
  // A builder test thread runs a draft (KOBE-85): never shared, never in a project.
  if (thread.isTest) return "test_thread";
  if (target === "team") return null;
  if (thread.projectId === null) return "not_in_project";
  // Sharing needs the owner to still be a member who can use the (unarchived) project: a removed
  // member's old thread can't be put back in front of the project.
  if (!(await canCreateInProject(tx, viewer, thread.projectId))) return "project_not_found";
  return null;
}

/** The columns for `target` when it differs from the thread's scope, else none. */
export function applyShareScope(
  thread: SummaryRow,
  target: ThreadVisibility | undefined,
): Partial<ShareColumns> {
  if (target === undefined || target === visibilityOf(thread)) return {};
  return shareColumnsFor(target);
}

/**
 * After the update: audits a changed scope (`thread.sharing_changed`, with the scope before it)
 * and, when readers may have lost access, has their open streams recheck at once.
 */
export async function recordShareScope(
  tx: KobeTx,
  viewer: Viewer,
  before: SummaryRow,
  after: SummaryRow,
): Promise<void> {
  const from = visibilityOf(before);
  const to = visibilityOf(after);
  if (from === to) return;
  await recordAudit(tx, {
    action: "thread.sharing_changed",
    teamId: viewer.teamId,
    target: {
      threadId: after.id,
      projectId: after.projectId,
      shared: to !== "private",
      visibility: to,
      from,
    },
  });
  if (narrows(from, to)) await notifyThreadAccess(tx, viewer.teamId, after.id);
}

/**
 * Ends every share of a member's threads in the team (KOBE-221, fail closed): called when they are
 * removed from the team or deactivated, inside that change's transaction (`withTeam` of `teamId`).
 * Nobody else may change their threads, so a share would otherwise outlive the member with no one
 * able to revoke it. Each is audited (`thread.sharing_changed`, system actor) and open reader
 * streams recheck at once. Returns how many threads were made private.
 */
export async function endSharesOf(tx: KobeTx, teamId: string, userId: string): Promise<number> {
  const shared = await tx
    .select({
      id: threads.id,
      projectId: threads.projectId,
      sharedToProject: threads.sharedToProject,
      sharedToTeam: threads.sharedToTeam,
    })
    .from(threads)
    .where(
      and(
        eq(threads.teamId, teamId),
        eq(threads.ownerUserId, userId),
        sql`(${threads.sharedToProject} OR ${threads.sharedToTeam})`,
      ),
    )
    .orderBy(threads.id)
    .for("no key update");
  if (shared.length === 0) return 0;
  await tx
    .update(threads)
    .set({ sharedToProject: false, sharedToTeam: false })
    .where(
      and(
        eq(threads.teamId, teamId),
        eq(threads.ownerUserId, userId),
        sql`(${threads.sharedToProject} OR ${threads.sharedToTeam})`,
      ),
    );
  for (const thread of shared) {
    await notifyThreadAccess(tx, teamId, thread.id);
    await recordAudit(tx, {
      action: "thread.sharing_changed",
      teamId,
      actor: SYSTEM_ACTOR,
      target: {
        threadId: thread.id,
        projectId: thread.projectId,
        shared: false,
        visibility: "private",
        from: visibilityOf(thread),
      },
    });
  }
  return shared.length;
}

/**
 * A deactivated user's shares end in every team they belong to (KOBE-221): the `deactivated`
 * lifecycle hook, one `withTeam` per team (a transaction holds one team). Throws when any team
 * failed, so the step is reported as incomplete; reads already ignore the shares of a deactivated
 * owner (`sharedWith`), so a failure never leaves them readable.
 */
export async function endUserShares(db: KobeDb, userId: string): Promise<void> {
  const teams = await listMemberships(db, userId);
  const failures: unknown[] = [];
  for (const { teamId } of teams) {
    try {
      await withTeam(db, teamId, (tx) => endSharesOf(tx, teamId, userId));
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} of ${teams.length} teams' thread shares not ended`,
    );
  }
}

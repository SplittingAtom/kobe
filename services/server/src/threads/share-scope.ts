import type { ThreadVisibility } from "@kobe/protocol";
import type { KobeTx } from "@kobe/db";
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

import { withTeam } from "@kobe/db";
import type { ServerDeps } from "../deps.js";
import { notifyWorkspaceAccess } from "../event-stream/access.js";
import { logger } from "../logger.js";
import { endCheckoutsWithoutEditInTx } from "../projects/offboard.js";

/**
 * What follows a committed membership change outside its transaction. Shared by the Team console
 * routes and the identity provider's access mappings (KOBE-627), so a removal or a role change
 * has the same effects whoever made it.
 */
export type AfterChangeDeps = Pick<
  ServerDeps,
  "database" | "runs" | "projectMounts" | "sandboxWire" | "offboarding"
>;

/**
 * After a role change: a demoted team admin no longer edits projects without a row of their own,
 * so those checkouts end (KOBE-579); mounts are brought in line (MT2).
 */
export async function afterMemberRoleChanged(
  deps: AfterChangeDeps,
  teamId: string,
  userId: string,
): Promise<void> {
  await withTeam(deps.database.db, teamId, (tx) => endCheckoutsWithoutEditInTx(tx, teamId, userId));
  await deps.projectMounts.reconcileUser(teamId, userId);
}

/** After a removal (its transaction already paused the member's schedules in the team). */
export async function afterMemberRemoved(
  deps: AfterChangeDeps,
  teamId: string,
  userId: string,
): Promise<void> {
  // Their scheduled runs here stop while the sandbox still answers (KOBE-180); the schedules were
  // paused with the removal. A failure is logged; the scheduler's owner sweep cancels what is left
  // at its next tick (KOBE-252, scheduler/owner-sweep.ts).
  try {
    await deps.runs.cancelScheduledRuns(teamId, userId, "member_removed");
  } catch (err) {
    logger.error({ err, team_id: teamId }, "cancelling scheduled runs after member removal failed");
  }
  // Every project mount leaves their workspace (MT4); never fails the removal (logged inside).
  await deps.projectMounts.reconcileUser(teamId, userId);
  // The removed member's sandbox in this team loses its connection on every replica (KOBE-24).
  await deps.sandboxWire.revalidateUser(userId);
  // Their open file change streams end now on every replica, not at the next recheck (KOBE-496).
  await notifyWorkspaceAccess(deps.database.db, userId).catch((err: unknown) => {
    logger.warn({ err, team_id: teamId }, "workspace access hint after member removal failed");
  });
  // The sandbox is destroyed at once and the volume kept 30 days (D12, KOBE-28). The removal is
  // done either way; a failure here is finished by the offboarding sweep.
  try {
    await deps.offboarding.offboardMember(teamId, userId, "member_removed");
  } catch (err) {
    logger.error({ err, team_id: teamId }, "offboarding after member removal failed");
  }
}

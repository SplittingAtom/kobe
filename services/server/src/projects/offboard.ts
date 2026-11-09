import {
  listMemberships,
  sql,
  SYSTEM_ACTOR,
  withTeam,
  type AuditActor,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { endUnreachableThreadRules } from "../policy/user-rules.js";
import { loadAccess } from "./access.js";
import type { ProjectMounts } from "./mounts.js";

/**
 * A member's standing in the workspace's projects ends when they leave it or are deactivated
 * (Workspaces PJ3/MT4, KOBE-578): their checkouts are discarded (rows deleted, each audited
 * `project.checkout_discarded {reason: member_removed}`; the folder relock is the sandbox's,
 * KOBE-579/580) and their explicit project rows go. A project whose only owner this was keeps
 * running without one (PR5: team admins see it under "No owner"). The caller then reconciles the
 * user's mounts ({@link ProjectMounts.reconcileUser}), outside this transaction. `actor`: the
 * request's signed-in user when absent (a team admin removing the member).
 */
export async function endProjectStandingInTx(
  tx: KobeTx,
  teamId: string,
  userId: string,
  actor?: AuditActor,
): Promise<void> {
  const ended = await tx.execute<{ project_id: string }>(sql`
    DELETE FROM project_checkouts WHERE team_id = ${teamId} AND user_id = ${userId}
    RETURNING project_id`);
  for (const { project_id: projectId } of ended.rows) {
    await recordAudit(tx, {
      action: "project.checkout_discarded",
      teamId,
      target: { projectId, userId, reason: "member_removed" },
      ...(actor ? { actor } : {}),
    });
  }
  const dropped = await tx.execute(
    sql`DELETE FROM project_members WHERE team_id = ${teamId} AND user_id = ${userId}`,
  );
  // Remembered approvals in threads they can no longer reach end for good (as a project removal).
  if ((dropped.rowCount ?? 0) > 0) await endUnreachableThreadRules(tx, teamId);
}

/**
 * A role change that took away `edit` (an editor made reader, an editor row removed from a
 * workspace project, a team admin demoted; KOBE-579) ends the member's checkouts of the projects
 * they may no longer edit, as when they leave (MT4): rows deleted, audited
 * `project.checkout_discarded {reason: access_lost}`. The caller then reconciles the user's mounts
 * outside this transaction: the head is written back (or the mount goes if no conversation keeps
 * it) and the sandbox relocks the folder at its next pull. Returns how many ended.
 */
export async function endCheckoutsWithoutEditInTx(
  tx: KobeTx,
  teamId: string,
  userId: string,
  actor?: AuditActor,
): Promise<number> {
  const held = await tx.execute<{ project_id: string }>(sql`
    SELECT project_id FROM project_checkouts WHERE team_id = ${teamId} AND user_id = ${userId}`);
  let ended = 0;
  for (const { project_id: projectId } of held.rows) {
    const access = await loadAccess(tx, { teamId, userId }, projectId);
    if (access?.can.edit) continue;
    await tx.execute(sql`
      DELETE FROM project_checkouts
       WHERE team_id = ${teamId} AND project_id = ${projectId} AND user_id = ${userId}`);
    await recordAudit(tx, {
      action: "project.checkout_discarded",
      teamId,
      target: { projectId, userId, reason: "access_lost" },
      ...(actor ? { actor } : {}),
    });
    ended += 1;
  }
  return ended;
}

/**
 * Deactivation (MT4): {@link endProjectStandingInTx} in every workspace the user belongs to, then
 * their mounts are reconciled (their threads stay; nothing stays mounted while deactivated). Kobe
 * does it (system actor). Every team is tried; failures are thrown together, like `endUserShares`.
 */
export async function endUserProjects(
  db: KobeDb,
  mounts: ProjectMounts,
  userId: string,
): Promise<void> {
  const teams = await listMemberships(db, userId);
  const failures: unknown[] = [];
  for (const { teamId } of teams) {
    try {
      await withTeam(db, teamId, (tx) => endProjectStandingInTx(tx, teamId, userId, SYSTEM_ACTOR));
      await mounts.reconcileUser(teamId, userId);
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} of ${teams.length} teams' project standing not ended`,
    );
  }
}

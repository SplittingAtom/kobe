import {
  SYSTEM_ACTOR,
  and,
  eq,
  listMemberships,
  schedules,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import type { ServerRunOrchestrator } from "../runs/orchestrator.js";

/**
 * Deactivation and team removal stop a user's schedules (KOBE-180, D7/D32). Their active schedules
 * are paused with `paused_by = deactivation` and stay paused after a reactivation or a return to
 * the team until the owner resumes each one (coordinator decision 2026-10-09); a team admin's pause
 * and the owner's own pause are left as they are. Their in-flight scheduled runs are cancelled.
 *
 * Order matters: the pause UPDATE waits for any fire holding the schedule row (the runner's lease,
 * KOBE-174), so a run fired just before the pause is committed, and therefore visible, when the
 * cancel looks for runs afterwards. A fire after the pause finds the schedule inactive.
 */

export type ScheduleStopCause = "deactivation" | "member_removed";

/**
 * Pauses the user's active schedules in `teamId`, inside the caller's `withTeam()` transaction.
 * Audited as the system, one `schedule.deactivated` per schedule. Returns the paused ids.
 */
export async function pauseOwnerSchedulesInTx(
  tx: KobeTx,
  teamId: string,
  userId: string,
  by: ScheduleStopCause,
): Promise<string[]> {
  const paused = await tx
    .update(schedules)
    .set({ active: false, pausedBy: "deactivation", nextDueAt: null, updatedAt: new Date() })
    .where(
      and(eq(schedules.teamId, teamId), eq(schedules.userId, userId), eq(schedules.active, true)),
    )
    .returning({ id: schedules.id });
  for (const { id } of paused) {
    await recordAudit(tx, {
      action: "schedule.deactivated",
      actor: SYSTEM_ACTOR,
      teamId,
      target: { scheduleId: id, by },
    });
  }
  return paused.map((p) => p.id);
}

type Runs = Pick<ServerRunOrchestrator, "cancelScheduledRuns">;

/**
 * The `deactivated` lifecycle hook: in every team of the user (memberships are kept while
 * deactivated), pause their schedules, then cancel their in-flight scheduled runs. Every team is
 * attempted; throws afterwards if any failed, so the deactivation reports the step incomplete.
 */
export async function stopUserSchedules(db: KobeDb, runs: Runs, userId: string): Promise<void> {
  const teams = await listMemberships(db, userId);
  const failures: unknown[] = [];
  for (const { teamId } of teams) {
    try {
      await withTeam(db, teamId, (tx) =>
        pauseOwnerSchedulesInTx(tx, teamId, userId, "deactivation"),
      );
      await runs.cancelScheduledRuns(teamId, userId, "owner_deactivated");
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} of ${teams.length} teams' schedules not stopped`,
    );
  }
}

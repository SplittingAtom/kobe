import {
  SYSTEM_ACTOR,
  and,
  eq,
  listMemberships,
  or,
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
 * the team until the owner resumes each one (coordinator decision 2026-10-09). A team admin's pause
 * becomes `deactivation` too (review of #235): left as `team_admin`, an admin could resume it and it
 * would fire after reactivation without the owner's say. The owner's own pause is left as it is.
 * Their in-flight scheduled runs are cancelled.
 *
 * Order matters: the pause UPDATE waits for any fire holding the schedule row (the runner's lease,
 * KOBE-174), so a run fired just before the pause is committed, and therefore visible, when the
 * cancel looks for runs afterwards. A fire after the pause finds the schedule inactive.
 */

export type ScheduleStopCause = "deactivation" | "member_removed";

/**
 * Pauses the user's active (and admin-paused) schedules in `teamId`, inside the caller's
 * `withTeam()` transaction. Audited as the system, one `schedule.deactivated` per schedule.
 * Returns the paused ids.
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
      and(
        eq(schedules.teamId, teamId),
        eq(schedules.userId, userId),
        or(eq(schedules.active, true), eq(schedules.pausedBy, "team_admin")),
      ),
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
 * attempted; throws afterwards if any failed, so the deactivation reports the step incomplete,
 * and the scheduler's owner sweep finishes it at its next tick (KOBE-252).
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

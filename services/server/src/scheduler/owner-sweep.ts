import { sql, withTeam, type KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import type { ScheduledCancelReason } from "../runs/cancel-scheduled.js";
import type { ServerRunOrchestrator } from "../runs/orchestrator.js";
import { principalActive } from "../runs/store.js";
import { pauseOwnerSchedulesInTx, type ScheduleStopCause } from "../schedules/offboard.js";

/**
 * Finishes what a deactivation or a team removal left undone (KOBE-252). Both stop the user's
 * schedules in two steps: pause them, then cancel their in-flight scheduled runs (KOBE-180). A
 * removal pauses in its own transaction but cancels afterwards, best effort; a deactivation's
 * `schedules` hook does both per team and only reports a failure. Nothing retried either, so a
 * scheduled run could keep working for an owner who is gone, and a schedule left active would fire
 * again once its owner came back.
 *
 * Each scheduler tick, per team: owners who are deactivated or no longer members but still have
 * an active (or team-admin-paused) schedule or an in-flight scheduled run get both steps again,
 * as the system. Idempotent: what is done no longer matches, so a later tick finds nothing.
 */
export interface OwnerSweepDeps {
  readonly db: KobeDb;
  readonly runs: Pick<ServerRunOrchestrator, "cancelScheduledRuns">;
  readonly log: Pick<Logger, "error" | "warn">;
}

interface InactiveOwner {
  readonly userId: string;
  readonly deactivated: boolean;
}

const STEPS: Record<"deactivated" | "removed", [ScheduleStopCause, ScheduledCancelReason]> = {
  deactivated: ["deactivation", "owner_deactivated"],
  removed: ["member_removed", "member_removed"],
};

/** Owners in `teamId` with something left to stop and who are no longer active there. */
async function inactiveOwners(db: KobeDb, teamId: string): Promise<InactiveOwner[]> {
  return withTeam(db, teamId, async (tx) => {
    const res = await tx.execute<{ user_id: string; deactivated: boolean }>(sql`
      SELECT o.user_id, u.deactivated_at IS NOT NULL AS deactivated
        FROM (SELECT s.user_id FROM schedules s
               WHERE s.team_id = ${teamId} AND (s.active OR s.paused_by = 'team_admin')
              UNION
              SELECT t.owner_user_id FROM runs r
                JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
               WHERE r.team_id = ${teamId} AND t.team_id = ${teamId} AND r.trigger = 'schedule'
                 AND r.status IN ('queued', 'running', 'waiting_approval')
                 AND t.owner_user_id IS NOT NULL) AS o (user_id)
        LEFT JOIN users u ON u.id = o.user_id
        LEFT JOIN team_members m ON m.team_id = ${teamId} AND m.user_id = o.user_id
       WHERE u.deactivated_at IS NOT NULL OR m.user_id IS NULL`);
    return res.rows.map((r) => ({ userId: r.user_id, deactivated: r.deactivated }));
  });
}

/** Pauses (re-checking the owner under a share lock) and cancels; false if they came back. */
async function stopOwner(deps: OwnerSweepDeps, teamId: string, owner: InactiveOwner) {
  const [pauseCause, cancelReason] = STEPS[owner.deactivated ? "deactivated" : "removed"];
  const paused = await withTeam(deps.db, teamId, async (tx) => {
    if (await principalActive(tx, teamId, owner.userId)) return undefined;
    return pauseOwnerSchedulesInTx(tx, teamId, owner.userId, pauseCause);
  });
  if (paused === undefined) return false;
  const cancelled = await deps.runs.cancelScheduledRuns(teamId, owner.userId, cancelReason);
  deps.log.warn(
    {
      team_id: teamId,
      user_id: owner.userId,
      reason: cancelReason,
      paused: paused.length,
      cancelled: cancelled.length,
    },
    "finished stopping an inactive owner's schedules",
  );
  return true;
}

/**
 * One sweep of a team. Each owner is handled on its own: a failure is logged and the next tick
 * tries again. Returns how many owners were stopped.
 */
export async function sweepInactiveOwners(deps: OwnerSweepDeps, teamId: string): Promise<number> {
  let stopped = 0;
  for (const owner of await inactiveOwners(deps.db, teamId)) {
    try {
      if (await stopOwner(deps, teamId, owner)) stopped += 1;
    } catch (err) {
      deps.log.error(
        { err, team_id: teamId, user_id: owner.userId },
        "stopping an inactive owner's schedules failed; the next tick retries",
      );
    }
  }
  return stopped;
}

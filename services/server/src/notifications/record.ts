import type { NotificationKind, RunStatus } from "@kobe/protocol";
import { sql, type KobeTx } from "@kobe/db";
import { loadSkippedReport } from "../policy/skipped-actions.js";

/**
 * The notification kind for a scheduled run that ended in `to` (KOBE-176 contract), or null when
 * the end does not notify. A completed run with skipped actions reports those (not `succeeded`);
 * a budget stop is a failure. `cancelled` never notifies: its only cause is `user_cancelled`,
 * i.e. the owner's own Stop, or the system cancelling a deactivated or removed owner's runs
 * (KOBE-180), who must not be told anything.
 */
export function notificationKindOf(to: RunStatus, skippedCount: number): NotificationKind | null {
  switch (to) {
    case "completed":
      return skippedCount > 0 ? "schedule.run.skipped_actions" : "schedule.run.succeeded";
    case "failed":
    case "budget_stopped":
      return "schedule.run.failed";
    case "interrupted":
      return "schedule.run.interrupted";
    default:
      return null;
  }
}

export interface EndedRun {
  readonly teamId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly trigger: "user" | "schedule";
  readonly to: RunStatus;
}

/**
 * Records the in-app notification of a scheduled run's end, and its email when the schedule has
 * `notify_email` (spec D32, KOBE-179), in `tx`: the transaction that ends the run, so the two
 * commit together. Once per run (`notifications_run_kind_uniq`): a repeat is a no-op. Nothing for
 * user-triggered runs, for ends that do not notify, or when the thread's schedule is gone (the
 * contract needs its id). `skipped_count` is set whenever actions were skipped (KOBE-178), on any
 * kind. Ids and counts only; the email is rendered at delivery.
 */
export async function notifyScheduledRunEndInTx(tx: KobeTx, run: EndedRun): Promise<void> {
  if (run.trigger !== "schedule" || notificationKindOf(run.to, 0) === null) return;
  const skipped = (await loadSkippedReport(tx, run.teamId, run.runId)).count;
  const kind = notificationKindOf(run.to, skipped);
  if (kind === null) return;
  const inserted = await tx.execute<{ id: string; notify_email: boolean }>(sql`
    WITH src AS (
      SELECT t.owner_user_id, s.id AS schedule_id, s.notify_email
        FROM threads t
        JOIN schedules s ON s.team_id = t.team_id AND s.id = t.schedule_id
       WHERE t.team_id = ${run.teamId} AND t.id = ${run.threadId}
    ), ins AS (
      INSERT INTO notifications (team_id, user_id, kind, schedule_id, thread_id, run_id, skipped_count)
      SELECT ${run.teamId}::uuid, owner_user_id, ${kind}::text, schedule_id, ${run.threadId}::uuid,
             ${run.runId}::uuid,
             ${skipped > 0 ? skipped : null}::int
        FROM src
      ON CONFLICT DO NOTHING
      RETURNING id
    )
    SELECT ins.id, src.notify_email FROM ins CROSS JOIN src`);
  const row = inserted.rows[0];
  if (!row?.notify_email) return;
  await tx.execute(sql`
    INSERT INTO notification_emails (team_id, notification_id)
    VALUES (${run.teamId}, ${row.id})
    ON CONFLICT DO NOTHING`);
}

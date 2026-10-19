/**
 * Words for a notification. Schedules have no name (KOBE-179), so a notification names its
 * schedule by when it runs ("Every day at 09:00 (Europe/Berlin)"); a schedule deleted since has
 * nothing to show and is called that.
 */
import type { ScheduleRecurrence } from "@kobe/protocol";
import type { KobeNotification } from "./api";
import { describeRecurrence } from "../schedules/format";

export interface ScheduleWhen {
  readonly recurrence: ScheduleRecurrence;
  readonly tz: string;
}

function skipped(count: number): string {
  return count === 1 ? "1 action was skipped" : `${count} actions were skipped`;
}

/** The headline: what happened to the run (or the schedule). */
export function notificationTitle(n: KobeNotification): string {
  switch (n.kind) {
    case "schedule.run.succeeded":
      return "Scheduled run finished";
    case "schedule.run.failed":
      return "Scheduled run failed";
    case "schedule.run.interrupted":
      return "Scheduled run was interrupted";
    case "schedule.run.skipped_actions":
      return `Scheduled run finished; ${skipped(n.skippedCount ?? 0)}`;
    case "schedule.paused":
      return n.pausedBy === "team_admin"
        ? "Schedule paused by a team admin"
        : "Schedule paused (access deactivated)";
    case "skill.member_add.blocked":
      return `A Team admin blocked ${n.skillName ?? "a catalog skill"} in this team; your Add for me was removed`;
  }
}

/** What the notification is about: its schedule, or the catalog skill (KOBE-338). */
export function notificationLabel(
  n: KobeNotification,
  known: ReadonlyMap<string, ScheduleWhen> | null,
): string {
  if (n.kind === "skill.member_add.blocked") return `Catalog skill ${n.skillName ?? ""}`.trim();
  return n.scheduleId === null
    ? "A schedule that no longer exists"
    : scheduleLabel(n.scheduleId, known);
}

/**
 * Which schedule: its recurrence and zone, or a placeholder when it is not among `known` (null:
 * the caller's schedules could not be loaded, so nothing is known about it either way).
 */
export function scheduleLabel(
  scheduleId: string,
  known: ReadonlyMap<string, ScheduleWhen> | null,
): string {
  if (known === null) return "One of your schedules";
  const s = known.get(scheduleId);
  return s ? `${describeRecurrence(s.recurrence)} (${s.tz})` : "A schedule that no longer exists";
}

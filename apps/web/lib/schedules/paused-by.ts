import type { SchedulePausedBy } from "@kobe/protocol";

const LABELS: Readonly<Record<SchedulePausedBy, string>> = {
  team_admin: "Paused by a team admin",
  deactivation: "Paused: owner deactivated or removed",
  agent_unavailable: "Paused: agent unavailable",
};

/**
 * Why a schedule is paused when its owner did not pause it (KOBE-173, KOBE-567): one wording for
 * the schedule lists, the Agents page's Schedules column and the paused notification (KOBE-570).
 */
export function pausedByLabel(pausedBy: SchedulePausedBy): string {
  return LABELS[pausedBy];
}

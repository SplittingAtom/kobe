import { IDLE_MINUTES_MAX, IDLE_MINUTES_MIN } from "../sandbox/config.js";

/** `teams.settings` key of a team's idle time before hibernation (D14: 5–60 minutes). */
export const TEAM_IDLE_MINUTES = "sandbox_idle_minutes";

/**
 * A team's idle minutes: its setting when it is an integer within D14's 5–60 range, else the
 * install default (Helm `sandbox.hibernation.idleMinutes`). An invalid setting never hibernates
 * sooner than 5 minutes or later than an hour.
 */
export function resolveIdleMinutes(teamSetting: unknown, fallback: number): number {
  if (
    typeof teamSetting === "number" &&
    Number.isInteger(teamSetting) &&
    teamSetting >= IDLE_MINUTES_MIN &&
    teamSetting <= IDLE_MINUTES_MAX
  ) {
    return teamSetting;
  }
  return fallback;
}

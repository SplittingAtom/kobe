import { defineDomain } from "./types.js";

/** Personal Schedules (KOBE-64–65). */
export const schedules = defineDomain({
  team: ["schedules", "notifications", "notification_emails", "run_skipped_actions"],
  installWide: [],
  grants: {},
  teamReferencing: {},
});

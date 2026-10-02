/**
 * Postgres setting that every team-table RLS policy reads. It is set transaction-locally inside
 * `withTeam()`; when unset (or reset to '' on a reused connection) policies match no rows.
 */
export const TEAM_ID_SETTING = "kobe.team_id";

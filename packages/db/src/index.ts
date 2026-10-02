/**
 * Postgres setting that every team-table RLS policy reads. It is set with `SET LOCAL` inside
 * `withTeam()` for each transaction; when unset, policies fail closed.
 */
export const TEAM_ID_SETTING = "kobe.team_id";

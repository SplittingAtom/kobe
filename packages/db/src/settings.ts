/**
 * Postgres setting that every team-table RLS policy reads. It is set transaction-locally inside
 * `withTeam()`; when unset (or reset to '' on a reused connection) policies match no rows.
 */
export const TEAM_ID_SETTING = "kobe.team_id";

/**
 * Break-glass (KOBE-16, spec D10): the grant a transaction reads under and the admin acting. Set
 * transaction-locally by `readWithBreakGlass()` only; the `break_glass_read` SELECT policies honor
 * them only while the grant is approved, unexpired and requested by that (active) install admin.
 */
export const BREAK_GLASS_GRANT_SETTING = "kobe.break_glass_grant";
export const BREAK_GLASS_ACTOR_SETTING = "kobe.break_glass_actor";

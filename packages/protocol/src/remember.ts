import { z } from "zod";
import { globSchema } from "./glob.js";
import { uuidSchema } from "./common.js";

/**
 * "Approve and remember" choices (D29, extended by KOBE-289). A remembered approval is a user
 * allow rule (`tool_rules`, scope user) for exactly one tool; the scope says how long and where it
 * holds. Every scope is enforced by the server's policy engine, never by the client:
 *
 * - `thread`: this conversation only (the rule names the thread; it ends when the thread is
 *   deleted, archived, or the member can no longer open it);
 * - `today`: until the end of the member's day, in the time zone stored on their profile;
 * - `run`: this run only (the rule names the run; it ends with the run);
 * - `day`, `month`: 1 day, 30 days from the decision;
 * - `forever`: until revoked.
 *
 * Expiries are computed by the server. Admin limits (`RememberLimits`) decide which scopes members
 * may use; the site floor's limits bind every team, and a team can only tighten them.
 */
export const REMEMBER_SCOPES = ["thread", "today", "run", "day", "month", "forever"] as const;
export const rememberScopeSchema = z.enum(REMEMBER_SCOPES);
export type RememberScope = z.infer<typeof rememberScopeSchema>;

/** The card's and the pages' words for each scope (also the tool card's "Allowed by your rule"). */
export const REMEMBER_SCOPE_LABELS: Readonly<Record<RememberScope, string>> = {
  thread: "this conversation",
  today: "until end of today",
  run: "this run only",
  day: "for 1 day",
  month: "for 30 days",
  forever: "until revoked",
};

/** Fixed lifetimes, seconds (the others end with their thread, run or day, or never). */
export const REMEMBER_FIXED_SECONDS: Readonly<Partial<Record<RememberScope, number>>> = {
  day: 24 * 3600,
  month: 30 * 24 * 3600,
};

/** Upper bound on an admin's max duration: one year. */
export const REMEMBER_MAX_DURATION_SECONDS = 366 * 24 * 3600;

/**
 * Admin limits on remembered approvals (KOBE-289 ac-5), stored for the site floor and for each
 * team. The effective limits of a team are the two combined by {@link tightenRememberLimits}.
 */
export const rememberLimitsSchema = z.strictObject({
  /** Scopes members may choose. Empty: nothing can be remembered. */
  scopes: z
    .array(rememberScopeSchema)
    .max(REMEMBER_SCOPES.length)
    .refine((s) => new Set(s).size === s.length, "scopes must not repeat"),
  /** Longest a remembered approval may last (seconds); null = no limit. */
  max_duration_seconds: z.number().int().positive().max(REMEMBER_MAX_DURATION_SECONDS).nullable(),
  /** Whether MCP connector tools may be remembered. */
  mcp_tools: z.boolean(),
  /** Whether remembered approvals must be "only this exact action" (an argument pattern). */
  exact_only: z.boolean(),
  /** Whether "Approve all waiting" is offered. */
  approve_all: z.boolean(),
});
export type RememberLimits = z.infer<typeof rememberLimitsSchema>;

/** Without any admin setting: everything allowed (as before KOBE-289), no time limit. */
export const DEFAULT_REMEMBER_LIMITS: RememberLimits = {
  scopes: [...REMEMBER_SCOPES],
  max_duration_seconds: null,
  mcp_tools: true,
  exact_only: false,
  approve_all: true,
};

/** Nothing may be remembered: what an unreadable stored setting falls back to (fail closed). */
export const CLOSED_REMEMBER_LIMITS: RememberLimits = {
  scopes: [],
  max_duration_seconds: null,
  mcp_tools: false,
  exact_only: true,
  approve_all: false,
};

function minDuration(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * The stricter of two limits, field by field (the site floor and a team's own): a team can only
 * tighten the floor, never loosen it, whatever it stores.
 */
export function tightenRememberLimits(a: RememberLimits, b: RememberLimits): RememberLimits {
  const allowed = new Set(b.scopes);
  return {
    scopes: REMEMBER_SCOPES.filter((s) => a.scopes.includes(s) && allowed.has(s)),
    max_duration_seconds: minDuration(a.max_duration_seconds, b.max_duration_seconds),
    mcp_tools: a.mcp_tools && b.mcp_tools,
    exact_only: a.exact_only || b.exact_only,
    approve_all: a.approve_all && b.approve_all,
  };
}

/** The fields where `team` would be looser than `floor` (a team may not save those). */
export function looserThanFloor(team: RememberLimits, floor: RememberLimits): string[] {
  const out: string[] = [];
  if (team.scopes.some((s) => !floor.scopes.includes(s))) out.push("scopes");
  const fmax = floor.max_duration_seconds;
  const tmax = team.max_duration_seconds;
  if (fmax !== null && (tmax === null || tmax > fmax)) out.push("max_duration_seconds");
  if (team.mcp_tools && !floor.mcp_tools) out.push("mcp_tools");
  if (!team.exact_only && floor.exact_only) out.push("exact_only");
  if (team.approve_all && !floor.approve_all) out.push("approve_all");
  return out;
}

/**
 * Whether a scope can be offered under `limits`: allowed by the admins, and a fixed lifetime no
 * longer than the max duration ("until revoked" is never within a max duration). Scopes that end
 * with their thread, run or day are offered and capped at the max duration instead.
 */
export function scopeWithinLimits(scope: RememberScope, limits: RememberLimits): boolean {
  if (!limits.scopes.includes(scope)) return false;
  const max = limits.max_duration_seconds;
  if (max === null) return true;
  if (scope === "forever") return false;
  const fixed = REMEMBER_FIXED_SECONDS[scope];
  return fixed === undefined || fixed <= max;
}

/**
 * A remember-rule as the member submits it with an approval (§6.1, KOBE-289). The tool must be
 * exactly the approved one; `exact: true` narrows the rule to this action with an argument pattern
 * the server derives from the approved canonical input (never one the client sends).
 */
export const rememberRuleSchema = z.strictObject({
  tool_glob: globSchema,
  scope: rememberScopeSchema,
  exact: z.boolean().default(false),
});
export type RememberRule = z.infer<typeof rememberRuleSchema>;

/** Most approvals one "Approve all waiting" resolves (the per-run approval cap). */
export const APPROVE_ALL_MAX = 100;

/**
 * `POST /v1/approvals/approve-all` (KOBE-289 ac-3): allow every listed pending approval of one
 * run, each signed and audited on its own. The client lists what it showed the member; the server
 * refuses the whole set if any of them may not be approved this way.
 */
export const approveAllBodySchema = z.strictObject({
  run_id: uuidSchema,
  approval_ids: z
    .array(uuidSchema)
    .min(2)
    .max(APPROVE_ALL_MAX)
    .refine((ids) => new Set(ids).size === ids.length, "approval ids must not repeat"),
});
export type ApproveAllBody = z.infer<typeof approveAllBodySchema>;

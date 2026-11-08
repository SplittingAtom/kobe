import { z } from "zod";
import { timestampSchema, uuidSchema } from "./common.js";
import { schedulePausedBySchema } from "./schedules.js";

/**
 * Agent rosters contract (KOBE-566, spec `docs/specs/agents-roster.md` AR1-AR7, AR16, §5, §6.4,
 * §6.5, §6.8). A roster entry lends a member's personal agent to a team or to the whole site by
 * reference with a version rule, never by copying its definition. Team-owned and gallery agents are
 * implicit members of their roster (no entry).
 *
 * REST (team-scoped like every agent request):
 * - `GET /v1/agents/roster?tab=personal|team|site[&cursor&limit]` → {@link agentRosterPageSchema}
 * - `POST /v1/agents/{id}/assignments` {@link assignAgentRequestSchema} → 201 (active) or
 *   202 (proposed) with {@link agentRosterEntryResponseSchema}
 * - `DELETE /v1/agents/{id}/assignments/{target}[?teamId]` → 200 with the withdrawn entry (owner;
 *   `teamId` names a team roster other than the active team, e.g. one the owner has left)
 * - `PUT /v1/team/agent-roster/{agentId}` and `PUT /v1/site/agent-roster/{agentId}`
 *   {@link updateAgentRosterEntryRequestSchema} → 200 {@link agentRosterUpdateResponseSchema}
 *
 * Errors are `{code, message}` with the codes of {@link AGENT_ROSTER_ERROR_CODES}.
 */

/** Assigned entries per team roster, and on the site roster (AR6). */
export const AGENT_ROSTER_CAP = 200;
/** Pending proposals per roster: proposals count separately from assigned entries. */
export const AGENT_ROSTER_PROPOSALS_CAP = 200;
/** Rows per roster page; the tab is paginated by (name, id) above this (§6.8). */
export const AGENT_ROSTER_PAGE_MAX = 200;
/** Assign, propose, decide, withdraw, transfer, adopt: per user per 10 minutes (§6.8). */
export const AGENT_ROSTER_WRITE_RATE = { windowMs: 10 * 60_000, max: 60 } as const;
/** A decision's note (decline reason), in characters. */
export const AGENT_ROSTER_NOTE_MAX = 500;

export const AGENT_ROSTER_TABS = ["personal", "team", "site"] as const;
export const agentRosterTabSchema = z.enum(AGENT_ROSTER_TABS);
export type AgentRosterTab = z.infer<typeof agentRosterTabSchema>;

export const AGENT_ROSTER_TARGETS = ["team", "site"] as const;
export const agentRosterTargetSchema = z.enum(AGENT_ROSTER_TARGETS);
export type AgentRosterTarget = z.infer<typeof agentRosterTargetSchema>;

export const AGENT_ROSTER_ENTRY_STATES = ["proposed", "active", "removed", "suspended"] as const;
export const agentRosterEntryStateSchema = z.enum(AGENT_ROSTER_ENTRY_STATES);
export type AgentRosterEntryState = z.infer<typeof agentRosterEntryStateSchema>;

/**
 * A version rule in a request: `"latest"` follows the owner's latest published version (the
 * default), a number pins that published version (AR5).
 */
export const agentVersionRuleInputSchema = z.union([
  z.literal("latest"),
  z.number().int().positive().max(1_000_000),
]);
export type AgentVersionRuleInput = z.infer<typeof agentVersionRuleInputSchema>;

/** A roster entry as stored: ids and timestamps only (AR3). */
export const agentRosterEntrySchema = z.strictObject({
  agentId: uuidSchema,
  target: agentRosterTargetSchema,
  /** The team of a team entry; null on the site roster. */
  teamId: uuidSchema.nullable(),
  state: agentRosterEntryStateSchema,
  versionRule: z.enum(["latest", "pinned"]),
  pinnedVersion: z.number().int().positive().nullable(),
  assignedBy: uuidSchema,
  assignedAt: timestampSchema,
  decidedBy: uuidSchema.nullable(),
  decidedAt: timestampSchema.nullable(),
  note: z.string().max(AGENT_ROSTER_NOTE_MAX).nullable(),
  removedAt: timestampSchema.nullable(),
});
export type AgentRosterEntry = z.infer<typeof agentRosterEntrySchema>;

/** Where one of the viewer's own agents reaches (the Personal tab's Reach column, AR2). */
export const agentReachSchema = z.strictObject({
  target: agentRosterTargetSchema,
  teamId: uuidSchema.nullable(),
  /** The team's name (team entries); null on the site roster. */
  teamName: z.string().nullable(),
  state: agentRosterEntryStateSchema,
  /** A decision's note (a decline's reason), shown to the owner. */
  note: z.string().nullable(),
});
export type AgentReach = z.infer<typeof agentReachSchema>;

/** How an assignment would land for the viewer: directly, as a proposal, or not offered. */
export const agentAssignModeSchema = z.enum(["direct", "propose"]).nullable();

/**
 * What the viewer may do with a row (§5 matrix; the server enforces the same rules). Admin actions
 * (`decide`, `remove`, `pin`, `suspendSiteWide`) act on the roster of the tab the row is on.
 */
export const agentRosterActionsSchema = z.strictObject({
  view: z.boolean(),
  viewDefinition: z.boolean(),
  edit: z.boolean(),
  fork: z.boolean(),
  /** Assign to the active team's roster (`direct`) or propose it there (`propose`). */
  assignTeam: agentAssignModeSchema,
  assignSite: agentAssignModeSchema,
  /** The owner withdraws the agent from the active team's roster / the site roster. */
  withdrawTeam: z.boolean(),
  withdrawSite: z.boolean(),
  /** Approve or decline a proposal (team admin on Team, site admin on Site). */
  decide: z.boolean(),
  /** Remove an assigned entry from this tab's roster. */
  remove: z.boolean(),
  /** Pin the entry to a version or move it (Update), on this tab's roster. */
  pin: z.boolean(),
  /** Team admins: suspend or resume the agent for the active team ("Suspended here"). */
  suspendHere: z.boolean(),
  resumeHere: z.boolean(),
  /** Site admins: suspend or resume a site roster entry for every team (Site tab). */
  suspendSiteWide: z.boolean(),
  resumeSiteWide: z.boolean(),
});
export type AgentRosterActions = z.infer<typeof agentRosterActionsSchema>;

/** Where the row's agent comes from: a member's personal agent, the team's own, or the gallery. */
export const agentRosterKindSchema = z.enum(["personal", "team_owned", "gallery"]);
export type AgentRosterKind = z.infer<typeof agentRosterKindSchema>;

/**
 * The row's status for this tab (AR1): `not_published` is a draft (assignable, not runnable,
 * AR4); `suspended_here` is this team's suspension, `suspended_site` a site admin's;
 * `unavailable` an entry whose owner left the team or was deactivated (AR10, KOBE-567: not
 * runnable, shown to the roster's admins only, with `unavailableReason`).
 */
export const agentRosterStatusSchema = z.enum([
  "active",
  "proposed",
  "not_published",
  "suspended_here",
  "suspended_site",
  "unavailable",
  "archived",
]);
export type AgentRosterStatus = z.infer<typeof agentRosterStatusSchema>;

/** Why an entry is Unavailable (AR10): its owner left the team (team entries) or was deactivated. */
export const AGENT_ROSTER_UNAVAILABLE_REASONS = ["owner_left", "owner_deactivated"] as const;
export const agentRosterUnavailableReasonSchema = z.enum(AGENT_ROSTER_UNAVAILABLE_REASONS);
export type AgentRosterUnavailableReason = z.infer<typeof agentRosterUnavailableReasonSchema>;

/** One of the active team's schedules of the agent, as the team inventory shows it (KOBE-180). */
export const agentRosterScheduleSchema = z.strictObject({
  scheduleId: uuidSchema,
  ownerUserId: uuidSchema,
  ownerName: z.string(),
  status: z.enum(["active", "paused"]),
  /** Why it is paused when its owner did not pause it. */
  pausedBy: schedulePausedBySchema.nullable(),
  nextDueAt: timestampSchema.nullable(),
});
export type AgentRosterSchedule = z.infer<typeof agentRosterScheduleSchema>;

/**
 * The team inventory's columns for one agent in the active team (KOBE-86, KOBE-570, AR12): runs of
 * the team's threads, the last one, tokens, the team's schedules and the latest Orbit score. Only
 * team admins get it (Team and Site tabs).
 */
export const agentRosterUsageSchema = z.strictObject({
  runCount: z.number().int().nonnegative(),
  lastRunAt: timestampSchema.nullable(),
  /** Input plus output tokens of the team's model calls; no money. */
  tokens: z.number().int().nonnegative(),
  schedules: z.array(agentRosterScheduleSchema),
  orbitScore: z.strictObject({
    status: z.enum(["none", "evaluating", "passed", "blocked", "errored"]),
    attackSuccessRate: z.number().nullable(),
    at: timestampSchema.nullable(),
  }),
  /** The caller may read the definition, which Export to Orbit needs (KOBE-91). */
  canExport: z.boolean(),
});
export type AgentRosterUsage = z.infer<typeof agentRosterUsageSchema>;

export const agentRosterRowSchema = z.strictObject({
  agentId: uuidSchema,
  kind: agentRosterKindSchema,
  slug: z.string(),
  name: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  /** The draft (own agents) or current version (others) is in Dangerous mode (AC1). */
  dangerous: z.boolean(),
  ownerUserId: uuidSchema.nullable(),
  ownerName: z.string().nullable(),
  /** The team a fork of team content is bound to (AR8); null when unbound. */
  boundTeamId: uuidSchema.nullable(),
  status: agentRosterStatusSchema,
  /** Set with `status = unavailable` (AR10). */
  unavailableReason: agentRosterUnavailableReasonSchema.optional(),
  /** The agent's latest published version; null when never published. */
  currentVersion: z.number().int().positive().nullable(),
  /** The version this roster runs: the entry's rule resolved; null when nothing is published. */
  versionInEffect: z.number().int().positive().nullable(),
  /** A pinned entry behind the agent's latest version (AR5 "Update available"). */
  updateAvailable: z.boolean(),
  /** This tab's roster entry (assigned personal agents); null for team-owned and gallery rows. */
  entry: agentRosterEntrySchema.nullable(),
  /** Personal tab only: the agent's entries in the viewer's teams and on the site. */
  reach: z.array(agentReachSchema).optional(),
  archivedAt: timestampSchema.nullable(),
  updatedAt: timestampSchema,
  actions: agentRosterActionsSchema,
  /** Team admins on the Team and Site tabs: the inventory's usage in the active team (AR12). */
  usage: agentRosterUsageSchema.optional(),
});
export type AgentRosterRow = z.infer<typeof agentRosterRowSchema>;

export const agentRosterQuerySchema = z.strictObject({
  tab: agentRosterTabSchema,
  /** The previous page's `nextCursor`. */
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(AGENT_ROSTER_PAGE_MAX).optional(),
});
export type AgentRosterQuery = z.infer<typeof agentRosterQuerySchema>;

export const agentRosterPageSchema = z.strictObject({
  tab: agentRosterTabSchema,
  rows: z.array(agentRosterRowSchema).max(AGENT_ROSTER_PAGE_MAX),
  /** Ordered by (name, id); null on the last page. */
  nextCursor: z.string().nullable(),
});
export type AgentRosterPage = z.infer<typeof agentRosterPageSchema>;

/**
 * `POST /v1/agents/{id}/assignments`: the team is the active team. A numeric `versionRule` (a pin)
 * is for the roster's admins only (`422 version_rule_not_allowed` otherwise, AR5).
 */
export const assignAgentRequestSchema = z.strictObject({
  target: agentRosterTargetSchema,
  versionRule: agentVersionRuleInputSchema.optional(),
});
export type AssignAgentRequest = z.infer<typeof assignAgentRequestSchema>;

/**
 * `PUT /v1/team|site/agent-roster/{agentId}` (roster admins). On an entry: `active` approves a
 * proposal or resumes, `removed` declines a proposal or removes an entry, `suspended` suspends;
 * `versionRule` with `active` pins or updates. On the team roster `suspended` / `active` (without
 * `versionRule`) suspends or resumes the agent for the team only (`team_agent_suspensions`; the
 * entry stays `active`), also for a team-owned agent or a site-wide one without a team entry.
 * `suspended` as an entry state exists only on the site roster (site-wide).
 */
export const updateAgentRosterEntryRequestSchema = z.strictObject({
  state: z.enum(["active", "removed", "suspended"]),
  versionRule: agentVersionRuleInputSchema.optional(),
  note: z.string().trim().max(AGENT_ROSTER_NOTE_MAX).optional(),
});
export type UpdateAgentRosterEntryRequest = z.infer<typeof updateAgentRosterEntryRequestSchema>;

export const agentRosterEntryResponseSchema = z.strictObject({ entry: agentRosterEntrySchema });
export type AgentRosterEntryResponse = z.infer<typeof agentRosterEntryResponseSchema>;

/** A team roster write on a site-wide agent with no team entry: this team's suspension. */
export const agentTeamSuspensionResponseSchema = z.strictObject({
  agentId: uuidSchema,
  suspendedHere: z.boolean(),
});
export type AgentTeamSuspensionResponse = z.infer<typeof agentTeamSuspensionResponseSchema>;

export const agentRosterUpdateResponseSchema = z.union([
  agentRosterEntryResponseSchema,
  agentTeamSuspensionResponseSchema,
]);
export type AgentRosterUpdateResponse = z.infer<typeof agentRosterUpdateResponseSchema>;

export const AGENT_ROSTER_ERROR_CODES = [
  "invalid_request",
  "forbidden",
  "agent_not_found",
  "roster_entry_not_found",
  "version_not_found",
  "agent_archived",
  "already_on_roster",
  "invalid_transition",
  "roster_limit",
  "agent_rostered",
  "agent_bound_to_team",
  "agent_not_published",
  "version_rule_not_allowed",
  "rate_limited",
  // Fork, transfer and adopt (KOBE-568, agent-ownership.ts).
  "transfer_not_found",
  "transfer_recipient_invalid",
  "slug_taken",
  "limit_reached",
] as const;
export const agentRosterErrorCodeSchema = z.enum(AGENT_ROSTER_ERROR_CODES);
export type AgentRosterErrorCode = z.infer<typeof agentRosterErrorCodeSchema>;

/** HTTP status per error code. */
export const AGENT_ROSTER_ERROR_STATUS = {
  invalid_request: 400,
  forbidden: 403,
  agent_not_found: 404,
  roster_entry_not_found: 404,
  version_not_found: 404,
  agent_archived: 409,
  already_on_roster: 409,
  invalid_transition: 409,
  roster_limit: 409,
  agent_rostered: 409,
  agent_bound_to_team: 422,
  agent_not_published: 422,
  version_rule_not_allowed: 422,
  rate_limited: 429,
  transfer_not_found: 404,
  transfer_recipient_invalid: 422,
  slug_taken: 409,
  limit_reached: 409,
} as const satisfies Record<AgentRosterErrorCode, number>;

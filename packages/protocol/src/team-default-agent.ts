import { z } from "zod";
import { uuidSchema } from "./common.js";

/**
 * The team's default agent for new threads (KOBE-571, spec agents-roster §7.7, goals: "a team
 * default agent chosen from the team roster"). Stored in the team's settings; when unset, or when
 * the chosen agent is not runnable for a member, new threads start with the site default (the
 * gallery agent Kobe, KOBE-458).
 *
 * REST (team-scoped):
 * - `GET /v1/team/default-agent` (any member) → {@link teamDefaultAgentSchema}
 * - `PUT /v1/team/default-agent` (team admins, `team.agents.manage`)
 *   {@link setTeamDefaultAgentRequestSchema} → {@link teamDefaultAgentSchema}; audited
 *   `team.default_agent_changed` (ids only)
 *
 * Errors are `{code, message}` with the codes of {@link TEAM_DEFAULT_AGENT_ERROR_CODES}.
 */

/** Where a choice comes from on the team's roster: the Team tab or the Site tab. */
export const teamDefaultAgentGroupSchema = z.enum(["team", "site"]);
export type TeamDefaultAgentGroup = z.infer<typeof teamDefaultAgentGroupSchema>;

/**
 * An agent the team admin may choose: a team-owned agent, an active team roster entry, a site
 * roster entry or a gallery agent that is published, active and not archived in this team.
 */
export const teamDefaultAgentOptionSchema = z.strictObject({
  agentId: uuidSchema,
  name: z.string(),
  slug: z.string(),
  group: teamDefaultAgentGroupSchema,
  /** The version members' new threads would pin (the roster's version in effect). */
  versionInEffect: z.number().int().positive(),
});
export type TeamDefaultAgentOption = z.infer<typeof teamDefaultAgentOptionSchema>;

export const teamDefaultAgentSchema = z.strictObject({
  /** The chosen agent; null when the team uses the site default. */
  agentId: uuidSchema.nullable(),
  /** The chosen agent is no longer on the roster or not runnable: the site default applies. */
  unavailable: z.boolean(),
  options: z.array(teamDefaultAgentOptionSchema),
});
export type TeamDefaultAgent = z.infer<typeof teamDefaultAgentSchema>;

/** `agentId: null` goes back to the site default. */
export const setTeamDefaultAgentRequestSchema = z.strictObject({ agentId: uuidSchema.nullable() });
export type SetTeamDefaultAgentRequest = z.infer<typeof setTeamDefaultAgentRequestSchema>;

export const TEAM_DEFAULT_AGENT_ERROR_CODES = [
  "invalid_request",
  "forbidden",
  "agent_not_eligible",
] as const;
export const teamDefaultAgentErrorCodeSchema = z.enum(TEAM_DEFAULT_AGENT_ERROR_CODES);
export type TeamDefaultAgentErrorCode = z.infer<typeof teamDefaultAgentErrorCodeSchema>;

export const TEAM_DEFAULT_AGENT_ERROR_STATUS = {
  invalid_request: 400,
  forbidden: 403,
  agent_not_eligible: 422,
} as const satisfies Record<TeamDefaultAgentErrorCode, number>;

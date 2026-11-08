import {
  AGENT_ROSTER_PAGE_MAX,
  agentRosterEntryResponseSchema,
  agentRosterPageSchema,
  agentRosterUpdateResponseSchema,
  assignAgentRequestSchema,
  updateAgentRosterEntryRequestSchema,
} from "@kobe/protocol";
import { z } from "zod";

/**
 * OpenAPI for agent rosters (KOBE-566, spec agents-roster AR16 without fork, transfer and adopt;
 * `routes/agent-roster.ts`), generated from the protocol schemas the routes validate with.
 */

type JsonSchema = Record<string, unknown>;

const schemaOf = (schema: z.ZodType, io: "input" | "output"): JsonSchema => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io,
    target: "draft-2020-12",
  }) as JsonSchema;
  return rest;
};

const json = (schemaName: string, description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } },
});

const body = (schemaName: string) => ({
  required: true,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } },
});

const teamHeader = (required: boolean) => ({
  name: "X-Kobe-Team",
  in: "header",
  required,
  description: "The team the client believes is active. Required on changes; must match.",
  schema: { type: "string", format: "uuid" },
});

const uuidPath = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
});

const TEAM_ERRORS = {
  "400": json("Error", "`invalid_request` or `team_header_required`."),
  "401": json("Error", "`unauthenticated`: no session."),
};
const RATE = { "429": json("Error", "`rate_limited`: 60 roster writes per user per 10 minutes.") };

const adminPut = (who: string, operationId: string, extra: string) => ({
  operationId,
  summary: `Approve, decline, pin, update, remove, suspend or resume an entry (${who})`,
  description:
    "On an entry: `active` approves a proposal (following latest unless `versionRule` is " +
    "given), resumes a suspended entry, or with `versionRule` pins or updates it; `removed` " +
    "declines a proposal (with an optional `note` shown to the proposer) or removes an entry; " +
    `\`suspended\` suspends it. ${extra}`,
  requestBody: body("UpdateAgentRosterEntryBody"),
});

export function agentRosterOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/agents/roster": {
      get: {
        operationId: "listAgentRoster",
        summary: "One tab of the Agents page with each row's actions for the caller (AR1, AR2)",
        description:
          "Personal: the caller's own agents with their Reach. Team: the active team's own " +
          "agents and assigned personal agents. Site: gallery agents and site-assigned personal " +
          "agents. Proposals show to the proposer and the roster's admins. Ordered and paged " +
          `by (name, id), at most ${AGENT_ROSTER_PAGE_MAX} rows per page.`,
        parameters: [
          {
            name: "tab",
            in: "query",
            required: true,
            schema: { type: "string", enum: ["personal", "team", "site"] },
          },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: AGENT_ROSTER_PAGE_MAX },
          },
          teamHeader(false),
        ],
        responses: {
          "200": json("AgentRosterPage", "The tab's rows."),
          ...TEAM_ERRORS,
          "403": json("Error", "`not_a_team_member`."),
          "409": json("Error", "`no_active_team` or `team_mismatch`."),
        },
      },
    },
    "/v1/agents/{id}/assignments": {
      post: {
        operationId: "assignAgent",
        summary: "Assign an agent to the active team's roster or the site roster, or propose it",
        description:
          "Builders assign their own personal agent to the team; members propose. Site admins " +
          "assign to the site; others propose published agents only. A builder may also put a " +
          "site-assigned agent on the team roster. Caps: 200 assigned entries and 200 proposals " +
          "per roster.",
        parameters: [uuidPath("id"), teamHeader(true)],
        requestBody: body("AssignAgentBody"),
        responses: {
          "201": json("AgentRosterEntryResult", "Assigned (active)."),
          "202": json("AgentRosterEntryResult", "Proposed: an admin decides."),
          ...TEAM_ERRORS,
          "403": json("Error", "`forbidden` (team content) or `not_a_team_member`."),
          "404": json("Error", "`agent_not_found` or `version_not_found`."),
          "409": json(
            "Error",
            "`already_on_roster`, `agent_archived`, `roster_limit`, `no_active_team` or " +
              "`team_mismatch`.",
          ),
          "422": json("Error", "`agent_bound_to_team` or `agent_not_published`."),
          ...RATE,
        },
      },
    },
    "/v1/agents/{id}/assignments/{target}": {
      delete: {
        operationId: "withdrawAgent",
        summary: "The owner withdraws their agent or proposal from the team or site roster",
        parameters: [
          uuidPath("id"),
          {
            name: "target",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["team", "site"] },
          },
          teamHeader(true),
        ],
        responses: {
          "200": json("AgentRosterEntryResult", "The entry, now removed."),
          ...TEAM_ERRORS,
          "403": json("Error", "`not_a_team_member`."),
          "404": json("Error", "`agent_not_found` or `roster_entry_not_found`."),
          "409": json("Error", "`no_active_team` or `team_mismatch`."),
          ...RATE,
        },
      },
    },
    "/v1/team/agent-roster/{agentId}": {
      put: {
        ...adminPut(
          "team admins",
          "updateTeamAgentRosterEntry",
          "Without a team entry, `suspended`/`active` suspends or resumes for the team a " +
            "team-owned agent or a site-wide agent (gallery or site roster).",
        ),
        parameters: [uuidPath("agentId"), teamHeader(true)],
        responses: {
          "200": json("AgentRosterUpdateResult", "The entry, or the team's suspension."),
          ...TEAM_ERRORS,
          "403": json("Error", "`forbidden` (not a team admin) or `not_a_team_member`."),
          "404": json("Error", "`roster_entry_not_found` or `version_not_found`."),
          "409": json(
            "Error",
            "`invalid_transition`, `roster_limit`, `no_active_team` or `team_mismatch`.",
          ),
          ...RATE,
        },
      },
    },
    "/v1/site/agent-roster/{agentId}": {
      put: {
        ...adminPut("site admins", "updateSiteAgentRosterEntry", "Suspension is site-wide."),
        parameters: [uuidPath("agentId")],
        responses: {
          "200": json("AgentRosterEntryResult", "The entry."),
          "400": json("Error", "`invalid_request`."),
          "401": json("Error", "`unauthenticated`: no session."),
          "403": json("Error", "`forbidden`: not a site admin."),
          "404": json("Error", "`roster_entry_not_found` or `version_not_found`."),
          "409": json("Error", "`invalid_transition` or `roster_limit`."),
          ...RATE,
        },
      },
    },
  };
}

export function agentRosterOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    AgentRosterPage: schemaOf(agentRosterPageSchema, "output"),
    AssignAgentBody: schemaOf(assignAgentRequestSchema, "input"),
    UpdateAgentRosterEntryBody: schemaOf(updateAgentRosterEntryRequestSchema, "input"),
    AgentRosterEntryResult: schemaOf(agentRosterEntryResponseSchema, "output"),
    AgentRosterUpdateResult: schemaOf(agentRosterUpdateResponseSchema, "output"),
  };
}

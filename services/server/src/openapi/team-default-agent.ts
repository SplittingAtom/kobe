import { setTeamDefaultAgentRequestSchema, teamDefaultAgentSchema } from "@kobe/protocol";
import { z } from "zod";

/**
 * OpenAPI for the team's default agent (KOBE-571, agents-roster §7.7;
 * `routes/team-default-agent.ts`), generated from the protocol schemas the route validates with.
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

const teamHeader = (required: boolean) => ({
  name: "X-Kobe-Team",
  in: "header",
  required,
  description: "The team the client believes is active. Required on changes; must match.",
  schema: { type: "string", format: "uuid" },
});

export function teamDefaultAgentOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/team/default-agent": {
      get: {
        operationId: "getTeamDefaultAgent",
        summary: "The team's default agent for new threads, with the roster's choices",
        description:
          "Null when the team uses the site default (the gallery agent Kobe). `unavailable` says " +
          "the chosen agent is no longer on the roster or runnable here: new threads then start " +
          "with the site default.",
        parameters: [teamHeader(false)],
        responses: {
          "200": json("TeamDefaultAgent", "The setting and the choices."),
          "401": json("Error", "`unauthenticated`: no session."),
          "403": json("Error", "`not_a_team_member`."),
          "409": json("Error", "`no_active_team` or `team_mismatch`."),
        },
      },
      put: {
        operationId: "setTeamDefaultAgent",
        summary: "Choose the team's default agent from its roster, or go back to the site default",
        description:
          "Team admins. The agent must be team-owned, an active team roster entry, a site roster " +
          "entry or a gallery agent that is published and active here. Audited " +
          "`team.default_agent_changed` (ids only).",
        parameters: [teamHeader(true)],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SetTeamDefaultAgentBody" },
            },
          },
        },
        responses: {
          "200": json("TeamDefaultAgent", "The new setting and the choices."),
          "400": json("Error", "`invalid_request` or `team_header_required`."),
          "401": json("Error", "`unauthenticated`: no session."),
          "403": json("Error", "`forbidden`: not a team admin."),
          "409": json("Error", "`no_active_team` or `team_mismatch`."),
          "422": json("Error", "`agent_not_eligible`: not a choice on the team's roster."),
        },
      },
    },
  };
}

export function teamDefaultAgentOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    TeamDefaultAgent: schemaOf(teamDefaultAgentSchema, "output"),
    SetTeamDefaultAgentBody: schemaOf(setTeamDefaultAgentRequestSchema, "input"),
  };
}

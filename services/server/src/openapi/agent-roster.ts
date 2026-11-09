import {
  AGENT_ROSTER_PAGE_MAX,
  agentAdoptResponseSchema,
  agentTransferAcceptedSchema,
  agentTransferListSchema,
  agentTransferResponseSchema,
  transferAgentRequestSchema,
  agentRosterEntryResponseSchema,
  agentRosterPageSchema,
  agentRosterUpdateResponseSchema,
  assignAgentRequestSchema,
  updateAgentRosterEntryRequestSchema,
} from "@kobe/protocol";
import { z } from "zod";

/**
 * OpenAPI for agent rosters (KOBE-566, spec agents-roster AR16; `routes/agent-roster.ts`), and
 * fork, transfer and adopt (KOBE-568; `routes/agent-transfer.ts`), generated from the protocol
 * schemas the routes validate with.
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
          "422": json(
            "Error",
            "`agent_bound_to_team`, `agent_not_published`, or `version_rule_not_allowed` (a " +
              "numeric versionRule from someone who is not the roster's admin).",
          ),
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
          {
            name: "teamId",
            in: "query",
            required: false,
            description:
              "Target team only: a team roster other than the active team (e.g. one the owner " +
              "has left). Membership is not required; the agent must be the caller's.",
            schema: { type: "string", format: "uuid" },
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
          "`suspended` / `active` without `versionRule` suspends or resumes the agent for this " +
            "team only (`team_agent_suspensions`; a team entry stays `active`), also for a " +
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
            "`invalid_transition`, `roster_limit`, `agent_archived` (approve), `no_active_team` " +
              "or `team_mismatch`.",
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
          "409": json("Error", "`invalid_transition`, `roster_limit` or `agent_archived`."),
          ...RATE,
        },
      },
    },
  };
}

const adopt = (who: string, operationId: string, into: string, headers: unknown[]) => ({
  post: {
    operationId,
    summary: `Adopt an assigned entry's agent into ${into} (${who}, AR10)`,
    description:
      "Copies the agent's current published version into a new agent, published as its v1 in " +
      "the same transaction, with fork provenance, and removes the entry (audited " +
      "`agent.adopted` and `agent.roster.removed`). Allowed whether or not the owner is still a " +
      "member. A bound agent is adopted only into its own team.",
    parameters: [uuidPath("agentId"), ...headers],
    responses: {
      "201": json("AgentAdoptResult", "The new agent and the removed entry."),
      "400": json("Error", "`invalid_request`."),
      "401": json("Error", "`unauthenticated`: no session."),
      "403": json("Error", `\`forbidden\`: not ${who.replace(/s$/, "")}.`),
      "404": json("Error", "`roster_entry_not_found`: no entry on this roster."),
      "409": json(
        "Error",
        "`invalid_transition` (a proposal, or removed: adopted already), `slug_taken` or " +
          "`limit_reached` (the roster owner's agent cap).",
      ),
      "422": json("Error", "`agent_not_published` or `agent_bound_to_team`."),
      ...RATE,
    },
  },
});

/** Fork, transfer and adopt (KOBE-568, agents-roster AR8, AR10, AR16). */
export function agentOwnershipOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/agents/{id}/fork": {
      post: {
        operationId: "forkAgent",
        summary: "Copy an agent into a new personal agent of the caller's (AR8)",
        description:
          "Offered to whoever may read the definition: `build` for team-owned and team-assigned " +
          "agents, `use` for site-assigned and gallery agents, and the owner. Copies the published " +
          "version (the draft of the caller's own or the team's unpublished agent). A fork of team " +
          "content or of a bound agent is bound to that team (`boundTeamId`): assignable there " +
          "only. A `scope` in the body is ignored with a warning.",
        parameters: [uuidPath("id"), teamHeader(true)],
        requestBody: body("ForkAgentBody"),
        responses: {
          "201": json("ForkAgentResult", "The personal copy, its binding and warnings."),
          ...TEAM_ERRORS,
          "403": json("Error", "`forbidden` (may not read the definition) or `not_a_team_member`."),
          "404": json("Error", "`agent_not_found`."),
          "409": json(
            "Error",
            "`slug_taken`, `limit_reached`, `no_active_team` or `team_mismatch`.",
          ),
          "422": json("Error", "`agent_not_published`: someone else's agent with no version yet."),
        },
      },
    },
    "/v1/agents/transfers": {
      get: {
        operationId: "listAgentTransfers",
        summary: "The caller's pending agent transfers, offered to them and by them (AR10)",
        parameters: [teamHeader(false)],
        responses: {
          "200": json("AgentTransferList", "Pending transfers, oldest first."),
          ...TEAM_ERRORS,
          "403": json("Error", "`not_a_team_member`."),
        },
      },
    },
    "/v1/agents/{id}/transfer": {
      post: {
        operationId: "transferAgent",
        summary: "The owner offers their personal agent to another member of the active team",
        description:
          "The recipient must accept. A bound agent goes only to a member of its bound team. A " +
          "new offer replaces a pending one. The owner's and the recipient's agent reads show it.",
        parameters: [uuidPath("id"), teamHeader(true)],
        requestBody: body("TransferAgentBody"),
        responses: {
          "201": json("AgentTransferResult", "The pending transfer."),
          ...TEAM_ERRORS,
          "403": json("Error", "`not_a_team_member`."),
          "404": json("Error", "`agent_not_found`: not the caller's personal agent."),
          "409": json("Error", "`no_active_team` or `team_mismatch`."),
          "422": json(
            "Error",
            "`transfer_recipient_invalid` (not another active member) or `agent_bound_to_team`.",
          ),
          ...RATE,
        },
      },
      delete: {
        operationId: "cancelAgentTransfer",
        summary: "The owner cancels a pending transfer, or the recipient declines it",
        parameters: [uuidPath("id"), teamHeader(true)],
        responses: {
          "204": { description: "Cancelled or declined." },
          ...TEAM_ERRORS,
          "404": json("Error", "`transfer_not_found`."),
          ...RATE,
        },
      },
    },
    "/v1/agents/{id}/transfer/accept": {
      post: {
        operationId: "acceptAgentTransfer",
        summary: "The recipient accepts: the agent, its roster entries and pins become theirs",
        parameters: [uuidPath("id"), teamHeader(true)],
        responses: {
          "200": json("AgentTransferAccepted", "The agent's new owner."),
          ...TEAM_ERRORS,
          "404": json("Error", "`transfer_not_found`."),
          "409": json("Error", "`slug_taken` or `limit_reached` (the recipient's)."),
          "422": json(
            "Error",
            "`transfer_recipient_invalid` (no longer a member) or `agent_bound_to_team`.",
          ),
          ...RATE,
        },
      },
    },
    "/v1/team/agent-roster/{agentId}/adopt": adopt(
      "team admins",
      "adoptTeamAgentRosterEntry",
      "a team-owned agent",
      [teamHeader(true)],
    ),
    "/v1/site/agent-roster/{agentId}/adopt": adopt(
      "site admins",
      "adoptSiteAgentRosterEntry",
      "a site-owned gallery agent without a repository key",
      [],
    ),
  };
}

export function agentRosterOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    AgentRosterPage: schemaOf(agentRosterPageSchema, "output"),
    AssignAgentBody: schemaOf(assignAgentRequestSchema, "input"),
    UpdateAgentRosterEntryBody: schemaOf(updateAgentRosterEntryRequestSchema, "input"),
    AgentRosterEntryResult: schemaOf(agentRosterEntryResponseSchema, "output"),
    AgentRosterUpdateResult: schemaOf(agentRosterUpdateResponseSchema, "output"),
    ForkAgentBody: {
      type: "object",
      additionalProperties: false,
      properties: {
        slug: { type: "string" },
        scope: { type: "string", description: "Ignored (a fork is always personal)." },
      },
    },
    ForkAgentResult: {
      type: "object",
      required: ["agent", "boundTeamId", "warnings"],
      properties: {
        agent: { type: "object", description: "The new personal agent with its draft." },
        boundTeamId: { type: ["string", "null"], format: "uuid" },
        warnings: {
          type: "array",
          items: {
            type: "object",
            required: ["path", "message"],
            properties: { path: { type: "string" }, message: { type: "string" } },
          },
        },
      },
    },
    TransferAgentBody: schemaOf(transferAgentRequestSchema, "input"),
    AgentTransferResult: schemaOf(agentTransferResponseSchema, "output"),
    AgentTransferList: schemaOf(agentTransferListSchema, "output"),
    AgentTransferAccepted: schemaOf(agentTransferAcceptedSchema, "output"),
    AgentAdoptResult: schemaOf(agentAdoptResponseSchema, "output"),
  };
}

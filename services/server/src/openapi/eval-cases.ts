import { z } from "zod";
import {
  agentEvalCaseSchema,
  agentEvalCasesSchema,
  evalCaseOptionsSchema,
  evalCasePreviewSchema,
  myEvalCaseSchema,
  myEvalCasesSchema,
  reviewEvalCaseBodySchema,
  shareEvalCaseBodySchema,
} from "@kobe/protocol";

/**
 * OpenAPI for shared eval cases (KOBE-276, `eval-cases/routes.ts`): the member's preview, share,
 * list and withdraw, and the agent owner's list, read and review. The schemas are
 * `@kobe/protocol` eval-cases.ts.
 */

type JsonSchema = Record<string, unknown>;

const json = (schemaName: string, description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } },
});
const body = (schemaName: string) => ({
  required: true,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } },
});

const uuid = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
});
const ID = uuid("id");
const CASE_ID = uuid("caseId");
const TEAM_HEADER = {
  name: "X-Kobe-Team",
  in: "header",
  required: false,
  description: "The team the client believes is active; must match when sent.",
  schema: { type: "string", format: "uuid" },
};

const COMMON = {
  "401": json("Error", "`unauthenticated`: no session."),
  "403": json("Error", "`not_a_team_member` or `forbidden` (no `team.chat`)."),
};
const TEAM_409 = "`no_active_team` or `team_mismatch`";
const SHARE_409 =
  "`not_shareable` (not your conversation, not your thumbs down, or a gallery agent), " +
  "`thread_unavailable` (Trash or a test thread), `exchange_unavailable`, `already_shared`";
const OWNER_403 = json("Error", "`forbidden`: you don't own this agent (team admins included).");

function memberPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/runs/{id}/eval-case/preview": {
      post: {
        operationId: "previewEvalCase",
        summary: "See exactly what sharing this answer as an eval case would store",
        description:
          "For the conversation's owner, on their own thumbs down. Shares nothing. Returns the " +
          "copy (prompt, answer, reasons and comment, plus what the options add), its digest and " +
          "what can be added: earlier exchanges, this answer's tool outputs, the prompt's files " +
          "(names only).",
        parameters: [ID, TEAM_HEADER],
        requestBody: body("EvalCaseOptions"),
        responses: {
          "200": json("EvalCasePreview", "The copy as it would be stored."),
          "400": json(
            "Error",
            "`invalid_request`: bad options, or an id this answer doesn't have.",
          ),
          ...COMMON,
          "404": json("Error", "`run_not_found`: unknown id, or a thread you can't read."),
          "409": json("Error", `${SHARE_409}, ${TEAM_409}.`),
        },
      },
    },
    "/v1/runs/{id}/eval-case": {
      post: {
        operationId: "shareEvalCase",
        summary: "Share this answer with the agent's owner as an eval case, as previewed",
        description:
          "Takes the previewed options and the preview's digest; refused with `preview_stale` " +
          "when the copy changed since. The agent's owner never sees who shared it. Not audited.",
        parameters: [ID, TEAM_HEADER],
        requestBody: body("ShareEvalCaseBody"),
        responses: {
          "201": json("MyEvalCase", "The shared case."),
          "400": json("Error", "`invalid_request`."),
          ...COMMON,
          "404": json("Error", "`run_not_found`."),
          "409": json("Error", `${SHARE_409}, \`preview_stale\`, ${TEAM_409}.`),
        },
      },
    },
    "/v1/eval-cases": {
      get: {
        operationId: "listMyEvalCases",
        summary: "The cases you shared in the active team",
        parameters: [TEAM_HEADER],
        responses: {
          "200": json("MyEvalCases", "Your cases, newest first."),
          ...COMMON,
          "409": json("Error", `${TEAM_409}.`),
        },
      },
    },
    "/v1/eval-cases/{id}": {
      delete: {
        operationId: "withdrawEvalCase",
        summary: "Withdraw a case you shared (deletes the copy)",
        description: "Your own cases only; 204 whether or not there was one.",
        parameters: [ID, TEAM_HEADER],
        responses: {
          "204": { description: "Withdrawn, or there was none." },
          ...COMMON,
          "409": json("Error", `${TEAM_409}.`),
        },
      },
    },
  };
}

function ownerPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/agents/{id}/eval-cases": {
      get: {
        operationId: "listAgentEvalCases",
        summary: "Cases members shared on this agent (its owner only)",
        description:
          "Open first, then accepted, then dismissed. Never who shared a case; the day only.",
        parameters: [ID, TEAM_HEADER],
        responses: {
          "200": json("AgentEvalCases", "The cases and the accepted count."),
          ...COMMON,
          "403": OWNER_403,
          "404": json("Error", "`agent_not_found`."),
          "409": json("Error", `${TEAM_409}.`),
        },
      },
    },
    "/v1/agents/{id}/eval-cases/{caseId}": {
      get: {
        operationId: "getAgentEvalCase",
        summary: "One shared case with its copied exchange",
        parameters: [ID, CASE_ID, TEAM_HEADER],
        responses: {
          "200": json("AgentEvalCase", "The case."),
          ...COMMON,
          "403": OWNER_403,
          "404": json("Error", "`agent_not_found` or `case_not_found`."),
          "409": json("Error", `${TEAM_409}.`),
        },
      },
      patch: {
        operationId: "reviewAgentEvalCase",
        summary: "Accept, dismiss or reopen a case, or write its expected behaviour",
        description:
          "Accepted cases (each with an expected behaviour) run in the agent's pre-publish " +
          "Orbit eval as an extra suite; their failure rate is held to the team's threshold.",
        parameters: [ID, CASE_ID, TEAM_HEADER],
        requestBody: body("ReviewEvalCaseBody"),
        responses: {
          "200": json("AgentEvalCase", "The reviewed case."),
          "400": json("Error", "`invalid_request`."),
          ...COMMON,
          "403": OWNER_403,
          "404": json("Error", "`agent_not_found` or `case_not_found`."),
          "409": json("Error", `\`expected_behaviour_required\`, \`case_limit\`, ${TEAM_409}.`),
        },
      },
    },
  };
}

export function evalCasesOpenApiPaths(): Record<string, Record<string, unknown>> {
  return { ...memberPaths(), ...ownerPaths() };
}

function schemaOf(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io,
    target: "draft-2020-12",
  }) as JsonSchema;
  return rest;
}

export function evalCasesOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    EvalCaseOptions: schemaOf(evalCaseOptionsSchema, "input"),
    ShareEvalCaseBody: schemaOf(shareEvalCaseBodySchema, "input"),
    EvalCasePreview: schemaOf(evalCasePreviewSchema, "output"),
    MyEvalCase: schemaOf(myEvalCaseSchema, "output"),
    MyEvalCases: schemaOf(myEvalCasesSchema, "output"),
    AgentEvalCases: schemaOf(agentEvalCasesSchema, "output"),
    AgentEvalCase: schemaOf(agentEvalCaseSchema, "output"),
    ReviewEvalCaseBody: schemaOf(reviewEvalCaseBodySchema, "input"),
  };
}

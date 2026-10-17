import { z } from "zod";
import {
  agentFeedbackTotalsSchema,
  answerFeedbackSchema,
  putFeedbackBodySchema,
  threadFeedbackSchema,
} from "@kobe/protocol";

/**
 * OpenAPI for answer feedback (KOBE-275, `routes/feedback.ts`): rating an answer (a run) and the
 * caller's ratings in a thread, and the agent owners' totals (`agents/feedback-routes.ts`). The
 * schemas are `@kobe/protocol` feedback.ts.
 */

type JsonSchema = Record<string, unknown>;

const json = (schemaName: string, description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } },
});

const ID = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
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

export function feedbackOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/runs/{id}/feedback": {
      put: {
        operationId: "rateAnswer",
        summary: "Rate an answer (thumbs up or down), or change your rating",
        description:
          "Anyone who can read the run's thread rates it for themselves: its owner and readers " +
          "of a project- or team-shared thread. One rating per run and member. Reasons and a " +
          "comment (at most 500 characters) go with a thumbs down only. The comment is shown to " +
          "its author only.",
        parameters: [ID, TEAM_HEADER],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/PutFeedbackBody" } },
          },
        },
        responses: {
          "200": json("AnswerFeedback", "The stored rating."),
          "400": json("Error", "`invalid_request`: the body does not match."),
          ...COMMON,
          "404": json(
            "Error",
            "`run_not_found` (unknown id, or a thread you can't read) or `entry_not_found`.",
          ),
          "409": json(
            "Error",
            "`run_not_ended`, `not_an_answer`, `thread_in_trash`, `test_thread`, " +
              "`no_active_team` or `team_mismatch`.",
          ),
        },
      },
      delete: {
        operationId: "clearAnswerRating",
        summary: "Clear your rating of an answer",
        description:
          "Removes the caller's own rating, if any, even after they lost access to the thread.",
        parameters: [ID, TEAM_HEADER],
        responses: {
          "204": { description: "Cleared, or there was none." },
          ...COMMON,
          "404": json("Error", "`run_not_found`: the id is not a uuid."),
          "409": json("Error", "`no_active_team` or `team_mismatch`."),
        },
      },
    },
    "/v1/agents/{id}/feedback": {
      get: {
        operationId: "getAgentFeedbackTotals",
        summary: "An agent's answer ratings per version, model, reason and day (counts only)",
        description:
          "For the agent's owners and the team's admins (a gallery agent: team admins), in the " +
          "active team, over a preset window: the last 7, 30 (default) or 90 finished UTC days. " +
          "No custom ranges. Numbers show only over `min_raters` raters other than the caller; a " +
          "breakdown is null unless every one of its cells has that many. Residual: comparing " +
          "nested windows, or the same window on different days, can still narrow raters down " +
          "over time.",
        parameters: [
          ID,
          {
            name: "window",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["7", "30", "90"], default: "30" },
          },
          TEAM_HEADER,
        ],
        responses: {
          "200": json("AgentFeedbackTotals", "The totals and the breakdowns that may be shown."),
          "400": json("Error", "`invalid_request`: any query but window=7, 30 or 90."),
          ...COMMON,
          "404": json("Error", "`not_found`: no agent with that id that you can see."),
          "409": json("Error", "`no_active_team` or `team_mismatch`."),
        },
      },
    },
    "/v1/threads/{id}/feedback": {
      get: {
        operationId: "getThreadFeedback",
        summary: "The thread's rateable answers with your ratings",
        description:
          "Every ended message run of the thread with its prompt entry and the caller's rating " +
          "(or null). None for a thread in Trash or a test thread.",
        parameters: [ID, TEAM_HEADER],
        responses: {
          "200": json("ThreadFeedback", "Answers and the caller's ratings."),
          ...COMMON,
          "404": json("Error", "`thread_not_found`: unknown id, or a thread you can't read."),
          "409": json("Error", "`no_active_team` or `team_mismatch`."),
        },
      },
    },
  };
}

function schemaOf(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io,
    target: "draft-2020-12",
  }) as JsonSchema;
  return rest;
}

export function feedbackOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    PutFeedbackBody: schemaOf(putFeedbackBodySchema, "input"),
    AnswerFeedback: schemaOf(answerFeedbackSchema, "output"),
    ThreadFeedback: schemaOf(threadFeedbackSchema, "output"),
    AgentFeedbackTotals: schemaOf(agentFeedbackTotalsSchema, "output"),
  };
}

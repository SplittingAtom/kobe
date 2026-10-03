import { z } from "zod";
import { pendingMessagesSchema } from "../routes/thread-pending.js";

/**
 * OpenAPI for `GET /v1/threads/{id}/pending-messages` (KOBE-32, `routes/thread-pending.ts`):
 * generated from the zod schema the route answers with.
 */

type JsonSchema = Record<string, unknown>;

const output = (schema: z.ZodType): JsonSchema => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io: "output",
    target: "draft-2020-12",
  }) as JsonSchema;
  return rest;
};

const json = (schemaName: string, description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } },
});

export function pendingOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/threads/{id}/pending-messages": {
      get: {
        operationId: "listPendingMessages",
        summary: "The text of the thread's queued messages and of its active run's prompt",
        description:
          "Messages that are not entries yet: each queued run (in start order, `queue_pos` 1 = " +
          "next; editable with `PATCH /v1/runs/{id}`) and the active run's message until Pi " +
          "commits it. Same visibility as `GET /v1/threads/{id}/runs`. Reads Postgres only.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "X-Kobe-Team",
            in: "header",
            required: false,
            description: "The team the client believes is active; must match when sent.",
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": json("PendingMessages", "Active run first (while uncommitted), then the queue."),
          "400": json("Error", "`invalid_request`: the id is not a uuid."),
          "401": json("Error", "`unauthenticated`: no session."),
          "403": json("Error", "`not_a_team_member` or `forbidden`."),
          "404": json(
            "Error",
            "`thread_not_found`: unknown id, or another user's or team's thread.",
          ),
          "409": json("Error", "`no_active_team` or `team_mismatch`."),
        },
      },
    },
  };
}

export function pendingOpenApiSchemas(): Record<string, JsonSchema> {
  return { PendingMessages: output(pendingMessagesSchema) };
}

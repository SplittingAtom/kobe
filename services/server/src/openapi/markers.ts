import { z } from "zod";
import { threadMarkersSchema } from "../routes/thread-markers.js";

/**
 * OpenAPI for `GET /v1/threads/{id}/markers` (KOBE-209, `routes/thread-markers.ts`): generated
 * from the zod schema the route answers with.
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

export function markersOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/threads/{id}/markers": {
      get: {
        operationId: "listThreadMarkers",
        summary: "How the thread's runs ended and how its approvals were decided",
        description:
          "What the chat marks inline that the entry tree does not hold: runs that ended " +
          "`interrupted` or `budget_stopped`, runs that started and were stopped (`cancelled`) " +
          "or `failed` (with the server's message), and decided approvals (outcome and cause " +
          "only). " +
          "Newest 500 of each, oldest first; `truncated` says older ones were left out. Visible " +
          "like the thread; approvals only to the run's user (a reader of a shared thread gets " +
          "none). Reads Postgres only.",
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
          "200": json(
            "ThreadMarkers",
            "Run outcomes, decided approvals and skill uses, oldest first.",
          ),
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

export function markersOpenApiSchemas(): Record<string, JsonSchema> {
  return { ThreadMarkers: output(threadMarkersSchema) };
}

import { z } from "zod";
import {
  compactThreadErrorSchema,
  compactThreadRequestSchema,
  compactThreadResponseSchema,
  type CompactThreadErrorCode,
} from "@kobe/protocol";

/**
 * OpenAPI for `POST /v1/threads/{id}/compact` (KOBE-212 contract, KOBE-213 route,
 * `routes/thread-compact.ts`): generated from the contract's zod schemas.
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

const codes = (...list: CompactThreadErrorCode[]) => list.map((c) => `\`${c}\``).join(", ");

export function compactOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/threads/{id}/compact": {
      post: {
        operationId: "compactThread",
        summary: "Compact the thread's conversation now",
        description:
          "The owner asks Pi to summarize the idle thread's older conversation (CE15), optionally " +
          "with a one-line `focus` for the summary. Runs as a compaction run (one active run per " +
          "thread, budgets and usage apply) in the owner's workspace, which is woken if needed; " +
          "answers once Pi has written the summary, whose `compaction` entry is then in the " +
          "thread's entries. Each error code has one fixed message.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          {
            name: "X-Kobe-Team",
            in: "header",
            required: false,
            description: "The team the client believes is active; must match when sent.",
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/CompactThreadRequest" } },
          },
        },
        responses: {
          "200": json("CompactThreadResponse", "Compacted: Pi's summary and token counts."),
          "400": json(
            "Error",
            "`invalid_request`: bad id or body (focus blank, too long, controls).",
          ),
          "401": json("Error", "`unauthenticated`: no session."),
          "403": json("Error", "`read_only` (a shared reader), `forbidden`, `not_a_team_member`."),
          "404": json(
            "Error",
            "`thread_not_found`: unknown id, or another user's or team's thread.",
          ),
          "409": json(
            "CompactThreadError",
            `${codes("thread_busy", "nothing_to_compact", "model_not_configured")}; also ` +
              "`thread_in_trash`, `no_active_team`, `team_mismatch` (as `Error`).",
          ),
          "429": json("Error", "`budget_exhausted`: the member's or team's budget is used up."),
          "502": json("CompactThreadError", codes("compaction_failed")),
          "503": json(
            "CompactThreadError",
            `${codes("sandbox_unavailable")}; also \`isolation_unavailable\` (as \`Error\`).`,
          ),
        },
      },
    },
  };
}

export function compactOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    CompactThreadRequest: schemaOf(compactThreadRequestSchema, "input"),
    CompactThreadResponse: schemaOf(compactThreadResponseSchema, "output"),
    CompactThreadError: schemaOf(compactThreadErrorSchema, "output"),
  };
}

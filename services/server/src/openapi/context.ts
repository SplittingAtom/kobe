import { z } from "zod";
import {
  threadContextErrorSchema,
  threadContextSchema,
  threadContextWakingSchema,
  type ThreadContextErrorCode,
} from "@kobe/protocol";

/**
 * OpenAPI for `GET /v1/threads/{id}/context` (KOBE-470, `routes/thread-context.ts`, spec
 * docs/specs/context-viewer.md): generated from the contract's zod schemas.
 */
type JsonSchema = Record<string, unknown>;

const schemaOf = (schema: z.ZodType): JsonSchema => {
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

const codes = (...list: ThreadContextErrorCode[]) => list.map((c) => `\`${c}\``).join(", ");

export function contextOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/threads/{id}/context": {
      get: {
        operationId: "getThreadContext",
        summary: "What the thread's latest model call sent the model",
        description:
          "The owner reads the context of the thread's latest model call, live from their " +
          "workspace, as ordered sections with text and token counts (scaled to the call's " +
          "reported prompt tokens) and the context window. `exact` is false when it was rebuilt " +
          "from the session because the workspace restarted since that call (`missing` lists " +
          "what it may lack). Nothing is stored; section text is untrusted, show it as plain " +
          "text. A sleeping workspace is woken: 202, ask again after `retry_after_ms`.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": json("ThreadContext", "The sections, in the order the model saw them."),
          "202": json("ThreadContextWaking", "The workspace is waking; ask again."),
          "400": json("Error", "`invalid_request`: bad id."),
          "401": json("Error", "`unauthenticated`: no session."),
          "403": json(
            "ThreadContextError",
            `${codes("not_owner")} (a reader the thread is shared with); also \`forbidden\`, ` +
              "`not_a_team_member` (as `Error`).",
          ),
          "404": json("Error", "`thread_not_found`: unknown id, or another user's or team's."),
          "409": json("ThreadContextError", codes("thread_busy", "context_unsupported")),
          "429": json("ThreadContextError", codes("rate_limited")),
          "502": json("ThreadContextError", codes("context_unavailable")),
          "503": json("ThreadContextError", codes("sandbox_unavailable")),
        },
      },
    },
  };
}

export function contextOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    ThreadContext: schemaOf(threadContextSchema),
    ThreadContextWaking: schemaOf(threadContextWakingSchema),
    ThreadContextError: schemaOf(threadContextErrorSchema),
  };
}

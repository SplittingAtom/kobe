import { z } from "zod";

/**
 * OpenAPI for a thread's usage (`GET /v1/threads/{id}/usage`, `routes/usage.ts`; KOBE-43/208):
 * per run, for the answers' footers, and the newest call's prompt size for the context gauge
 * (KOBE-211). `threadUsageResponseSchema` is the answer's contract; the route tests parse real
 * answers with it.
 */

type JsonSchema = Record<string, unknown>;

const count = z.number().int().nonnegative();

const usageTotals = {
  calls: count,
  input_tokens: count,
  output_tokens: count,
  cache_read_tokens: count,
  cache_write_tokens: count,
  /** Dollars of the priced calls, for display. */
  cost_usd: z.number().nonnegative(),
  /** The same sum as exact decimal text (10 places). */
  cost_usd_exact: z.string(),
  unpriced_calls: count,
  estimated_calls: count,
};

const runUsageSchema = z.strictObject({
  run_id: z.uuid(),
  /** The run's prompt entry: the chat shows the run's usage under its answer. */
  user_entry_id: z.string().nullable(),
  models: z.array(z.string()),
  ...usageTotals,
});

export const threadUsageResponseSchema = z.strictObject({
  thread_id: z.uuid(),
  totals: z.strictObject(usageTotals),
  /** Runs with model calls, in the order they first called a model. */
  runs: z.array(runUsageSchema),
  /** The newest call that read input (prompt plus cache read: the context's size); null before the first. */
  latest_call: z
    .strictObject({
      at: z.iso.datetime(),
      /** `<gateway provider>/<model>` as the call named it. */
      model: z.string(),
      /** Input tokens not read from a prompt cache. */
      input_tokens: count,
      cache_read_tokens: count,
    })
    .nullable(),
});

const json = (schemaName: string, description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } },
});

export function usageOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/threads/{id}/usage": {
      get: {
        operationId: "getThreadUsage",
        summary: "Token usage and spend of the thread's runs, and its newest call's prompt size",
        description:
          "Visible like the thread (its owner, project readers). Attribution to a run relies on " +
          "the sandbox naming it (advisory). `latest_call` is the newest model call that read " +
          "input: the chat's context gauge shows its input plus cache-read tokens.",
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
        responses: {
          "200": json("ThreadUsage", "Totals, per run usage and the newest call."),
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

export function usageOpenApiSchemas(): Record<string, JsonSchema> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(threadUsageResponseSchema, {
    io: "output",
    target: "draft-2020-12",
  }) as JsonSchema;
  return { ThreadUsage: schema };
}

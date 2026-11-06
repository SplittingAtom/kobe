import { z } from "zod";
import {
  branchSummaryErrorSchema,
  branchSummaryRequestSchema,
  branchSummaryResponseSchema,
  type BranchSummaryErrorCode,
} from "@kobe/protocol";

/**
 * OpenAPI for `POST /v1/threads/{id}/branch-summary` (KOBE-548, CT11; `routes/thread-branch-summary.ts`),
 * generated from the contract's zod schemas.
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

const codes = (...list: BranchSummaryErrorCode[]) => list.map((c) => `\`${c}\``).join(", ");

export function branchSummaryOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/threads/{id}/branch-summary": {
      post: {
        operationId: "summarizeBranch",
        summary: "Make a branch current and carry a summary of the branch left",
        description:
          "The owner switches the idle thread to `to_entry_id` and has Pi summarize the branch " +
          "being left (CT11), optionally with a one-line `focus`. Runs as a branch summary run " +
          "(one active run per thread, never queued; budgets and usage apply) in the owner's " +
          "workspace, woken if needed; answers once Pi wrote the `branch_summary` entry, which is " +
          "then the thread's leaf (`thread.updated.leaf_entry_id` on the run's stream). At most " +
          "20 summaries per thread; never automatic. Each error code has one fixed message.",
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
            "application/json": { schema: { $ref: "#/components/schemas/BranchSummaryRequest" } },
          },
        },
        responses: {
          "200": json("BranchSummaryResponse", "Summarized: the summary entry is the new leaf."),
          "400": json("Error", "`invalid_request`: bad id or body (entry, focus)."),
          "401": json("Error", "`unauthenticated`: no session."),
          "403": json(
            "BranchSummaryError",
            `${codes("read_only")} (a shared reader); also \`forbidden\`, \`not_a_team_member\` (as \`Error\`).`,
          ),
          "404": json(
            "Error",
            "`thread_not_found` (unknown, another user's or team's thread) or `entry_not_found` " +
              "(`to_entry_id` is not a message of this thread).",
          ),
          "409": json(
            "BranchSummaryError",
            `${codes("thread_busy", "nothing_to_summarize", "summary_limit", "model_not_configured", "test_thread")}; ` +
              "also `skill_eval_thread`, `thread_in_trash`, `no_active_team`, `team_mismatch` (as `Error`).",
          ),
          "429": json("Error", "`budget_exhausted`: the member's or team's budget is used up."),
          "502": json("BranchSummaryError", codes("summary_failed")),
          "503": json(
            "BranchSummaryError",
            `${codes("sandbox_unavailable")}; also \`isolation_unavailable\` (as \`Error\`).`,
          ),
        },
      },
    },
  };
}

export function branchSummaryOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    BranchSummaryRequest: schemaOf(branchSummaryRequestSchema, "input"),
    BranchSummaryResponse: schemaOf(branchSummaryResponseSchema, "output"),
    BranchSummaryError: schemaOf(branchSummaryErrorSchema, "output"),
  };
}

import { z } from "zod";
import { approvalResolutionBodySchema, approveAllBodySchema } from "@kobe/protocol";
import { rememberOptionsViewSchema } from "../approvals/remember-options.js";
import { approvalListSchema, approvalViewSchema } from "../approvals/view.js";

/**
 * OpenAPI for approvals (KOBE-37, spec §6.1 `POST /v1/approvals/{id}`, D29;
 * `routes/approvals.ts`): generated from the zod schemas the routes parse and answer with.
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

const teamHeader = {
  name: "X-Kobe-Team",
  in: "header",
  required: false,
  description: "The team the client believes is active; must match when sent.",
  schema: { type: "string", format: "uuid" },
};
const idParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};
const common = {
  "401": json("Error", "`unauthenticated`: no session."),
  "403": json("Error", "`not_a_team_member` or `forbidden`."),
};

export function approvalsOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/approvals": {
      get: {
        operationId: "listApprovals",
        summary: "Your approvals in the active team, newest first (at most 100)",
        parameters: [
          {
            name: "status",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["pending", "allowed", "denied", "expired"] },
          },
          {
            name: "run_id",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
          },
          teamHeader,
        ],
        responses: {
          "200": json("ApprovalList", "Only approvals of runs you own."),
          "400": json("Error", "`invalid_request`: unknown filter."),
          ...common,
        },
      },
    },
    "/v1/approvals/approve-all": {
      post: {
        operationId: "approveAllWaiting",
        summary: "Allow every listed pending approval of one run (only the run's user)",
        description:
          "Each approval is signed over its own (run, tool call, tool, canonical input) and " +
          "audited on its own. Refused as a whole when the team's limits forbid it, or any is " +
          "destructive or open-world, not pending, or not of this run.",
        parameters: [teamHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ApproveAllBody" } },
          },
        },
        responses: {
          "200": json("ApprovalList", "The approvals, now allowed."),
          "400": json("Error", "`invalid_request`."),
          ...common,
          "403": json("Error", "`approve_all_not_allowed`: the team's limits or a tool's risk."),
          "404": json("Error", "`approval_not_found`: unknown id, another run, user or team."),
          "409": json(
            "Error",
            "`approval_resolved`, `approval_expired`, `run_not_active` or `approval_unavailable`.",
          ),
          "503": json("Error", "`approvals_unavailable`: no approval key is configured."),
        },
      },
    },
    "/v1/approvals/{id}/remember": {
      get: {
        operationId: "getApprovalRememberOptions",
        summary: "What the approval card may offer for a pending approval",
        description:
          "The remember scopes the team's limits allow for this tool with the expiry the server " +
          "would set now, the exact-action pattern derived from the stored canonical input, and " +
          "whether Approve all waiting is offered for its run. The decisions check all of it again.",
        parameters: [idParam, teamHeader],
        responses: {
          "200": json("RememberOptions", "The options."),
          "400": json("Error", "`invalid_request`: the id is not a uuid."),
          ...common,
          "404": json("Error", "`approval_not_found`: unknown id, or another user's or team's."),
        },
      },
    },
    "/v1/approvals/{id}": {
      get: {
        operationId: "getApproval",
        summary: "One of your approvals, with the exact input it is signed over",
        parameters: [idParam, teamHeader],
        responses: {
          "200": json("Approval", "The approval."),
          "400": json("Error", "`invalid_request`: the id is not a uuid."),
          ...common,
          "404": json("Error", "`approval_not_found`: unknown id, or another user's or team's."),
        },
      },
      post: {
        operationId: "decideApproval",
        summary: "Allow or deny a pending approval (only the run's user)",
        description:
          "Allow signs HMAC(team, run, tool_call_id, tool, token expiry, canonical input) so " +
          "exactly the approved input runs, once. `remember` (allow only) writes a user allow " +
          "rule for exactly this tool with a scope (this conversation, until end of today, this " +
          "run, 1 day, 30 days, until revoked) and optionally only this exact action; the server " +
          "computes the expiry and the pattern and applies the team's remember limits. It never " +
          "lifts an ask or deny rule, nor applies to scheduled or auto runs. Pending approvals " +
          "expire after 1 hour; the run then ends.",
        parameters: [idParam, teamHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ApprovalDecisionBody" } },
          },
        },
        responses: {
          "200": json("Approval", "The decided approval."),
          "400": json(
            "Error",
            "`invalid_request`, `invalid_remember` (remember with deny, bad rule), `glob_too_broad` or `exact_unavailable`.",
          ),
          ...common,
          "403": json(
            "Error",
            "`not_a_team_member`, `forbidden` or `remember_not_allowed` (destructive tool, or the team's limits).",
          ),
          "404": json("Error", "`approval_not_found`: unknown id, or another user's or team's."),
          "409": json(
            "Error",
            "`approval_resolved`, `approval_expired`, `run_not_active` or `too_many_rules`.",
          ),
          "503": json("Error", "`approvals_unavailable`: no approval key is configured."),
        },
      },
    },
  };
}

export function approvalsOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    Approval: schemaOf(approvalViewSchema, "output"),
    ApprovalList: schemaOf(approvalListSchema, "output"),
    ApprovalDecisionBody: schemaOf(approvalResolutionBodySchema, "input"),
    ApproveAllBody: schemaOf(approveAllBodySchema, "input"),
    RememberOptions: schemaOf(rememberOptionsViewSchema, "output"),
  };
}

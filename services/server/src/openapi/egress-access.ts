import { EGRESS_REQUEST_SCOPES } from "@kobe/db";
import { z } from "zod";
import { decisionWithPatternBodySchema } from "../egress/decision-http.js";
import { ceilingFlagsBodySchema, egressRequestCreateBodySchema } from "../egress/schemas.js";

/**
 * OpenAPI for request access from the conversation (KOBE-39, KOBE-602 EA1-EA4;
 * `routes/egress-requests.ts`, the requests and flags of `routes/site-egress.ts`). Request bodies
 * are the schemas the routes validate with.
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

const uuidParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string", format: "uuid" },
});

const statusParam = {
  name: "status",
  in: "query",
  required: false,
  schema: { type: "string", enum: ["pending", "approved", "denied", "all"], default: "pending" },
};

const requestSchema = z.object({
  id: z.uuid(),
  domain: z.string().describe("The blocked host."),
  pattern: z.string().describe("The pattern approving it would enable (by default)."),
  status: z.enum(["pending", "approved", "denied"]),
  scope: z
    .enum(EGRESS_REQUEST_SCOPES)
    .describe("`team`: the team's admins decide; `site`: the site admins (outside the ceiling)."),
  internal: z.boolean().describe("The block was an internal address (`forbidden_address`)."),
  thread_id: z.uuid().nullable(),
  requested_by: z.object({ id: z.uuid(), name: z.string() }),
  decided_by: z.uuid().nullable(),
  created_at: z.iso.datetime(),
  decided_at: z.iso.datetime().nullable(),
});

const decisionResultSchema = z.object({
  request: requestSchema,
  settled: z.number().int().describe("Pending requests settled with this one."),
  enabled: z.boolean().describe("Approved and the pattern was not enabled for the team yet."),
  pattern: z.string().describe("The pattern decided."),
  ceiling: z
    .enum(["added", "restored"])
    .nullable()
    .describe("A site admin's approval added the pattern to the ceiling or put it back in."),
  internal: z.boolean().describe("The pattern is internal (same cluster) after the decision."),
});

const ceilingEntrySchema = z.object({
  domain: z.string(),
  preset: z.string().nullable(),
  in_ceiling: z.boolean(),
  internal: z.boolean().describe("Same cluster (EA4): may resolve to the internal targets."),
  note: z.string().nullable(),
  shared_hosting: z.boolean(),
  created_by: z.uuid().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

const decisionErrors = {
  "400": json("Error", "`invalid_request` or `team_header_required`."),
  "401": json("Error", "`unauthenticated`: no session."),
  "403": json(
    "Error",
    "`forbidden` (not an admin), `site_admin_required` (a team admin on a site-scope request) " +
      "or `internal_not_allowed` (only site admins mark a pattern internal).",
  ),
  "404": json("Error", "`request_not_found`."),
  "409": json(
    "Error",
    "`already_decided`, `not_in_ceiling` (a team admin's pattern is not in the ceiling) or " +
      "`too_many_domains`.",
  ),
  "422": json(
    "Error",
    "`invalid_pattern` (not a pattern, or a public suffix) or `pattern_not_covering` (the " +
      "pattern is neither the host nor a wildcard of one of its parents).",
  ),
};

const DECISION_DESCRIPTION =
  "Approve: a site admin (`site.egress.manage`) may approve any request with any pattern " +
  "covering the host (the exact host or `*.<parent>`, never a public suffix); the pattern is " +
  "added to the ceiling (or put back in), marked internal when `internal` is true, and enabled " +
  "for the request's team. A team admin (`team.egress.manage`) approves only team-scope " +
  "requests, with a ceiling pattern, never `internal`. Approving settles every pending request " +
  "in the team the pattern allows; denying every pending request for the request's pattern. " +
  "Audited `egress.request.decided` (with the ceiling and enablement events); the egress " +
  "proxies are told at once.";

export function egressAccessOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/egress/requests": {
      get: {
        operationId: "listMyEgressRequests",
        summary: "The caller's own access requests in the active team (last 30 days)",
        parameters: [
          teamHeader(false),
          { name: "domain", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: {
          "200": json("EgressRequestList", "Newest first."),
          "401": json("Error", "`unauthenticated`: no session."),
          "403": json("Error", "`not_a_team_member` or `forbidden`."),
          "409": json("Error", "`no_active_team` or `team_mismatch`."),
        },
      },
      post: {
        operationId: "createEgressRequest",
        summary: "Request access to a host the member's sandbox was blocked from",
        description:
          "Any host name: in the site ceiling the request is team-scope (the team's admins are " +
          "told), outside it, or with `reason: forbidden_address`, site-scope (the site admins " +
          "are told). One pending request per member and pattern; returns the existing one with " +
          "200. Audited `egress.request.created`.",
        parameters: [teamHeader(true)],
        requestBody: body("CreateEgressRequestBody"),
        responses: {
          "200": json("EgressRequestEnvelope", "Already pending: the existing request."),
          "201": json("EgressRequestEnvelope", "Created."),
          "400": json("Error", "`invalid_request` (not a host name) or `team_header_required`."),
          "401": json("Error", "`unauthenticated`: no session."),
          "403": json("Error", "`not_a_team_member` or `forbidden`."),
          "404": json("Error", "`thread_not_found`."),
          "409": json("Error", "`already_enabled`, `no_active_team` or `team_mismatch`."),
          "429": json("Error", "`too_many_requests`."),
        },
      },
    },
    "/v1/egress/requests/{id}/decision": {
      post: {
        operationId: "decideEgressRequest",
        summary: "Approve or deny an access request of the active team (the blocked card)",
        description: DECISION_DESCRIPTION,
        parameters: [teamHeader(true), uuidParam("id", "The request.")],
        requestBody: body("EgressRequestDecisionBody"),
        responses: {
          "200": json("EgressRequestDecision", "Decided."),
          ...decisionErrors,
        },
      },
    },
    "/v1/site/egress-ceiling/requests": {
      get: {
        operationId: "listSiteEgressRequests",
        summary: "Site-scope access requests across every team (site admins)",
        parameters: [statusParam],
        responses: {
          "200": json("SiteEgressRequestList", "Newest first."),
          "401": json("Error", "`unauthenticated`: no session."),
          "403": json("Error", "`forbidden`: not a site admin."),
        },
      },
    },
    "/v1/site/egress-ceiling/requests/{teamId}/{id}/decision": {
      post: {
        operationId: "decideSiteEgressRequest",
        summary: "Approve or deny any team's access request as a site admin",
        description: DECISION_DESCRIPTION,
        parameters: [uuidParam("teamId", "The request's team."), uuidParam("id", "The request.")],
        requestBody: body("EgressRequestDecisionBody"),
        responses: {
          "200": json("EgressRequestDecision", "Decided."),
          ...decisionErrors,
        },
      },
    },
    "/v1/site/egress-ceiling/{domain}": {
      put: {
        operationId: "setEgressCeilingFlags",
        summary: "Put a listed pattern into or out of the ceiling, or mark it internal",
        description:
          "Site admins. `internal` (same cluster, EA4): hosts the pattern matches may resolve to " +
          "the install's internal targets. Audited `egress.ceiling.changed` / " +
          "`egress.ceiling.internal_changed`.",
        parameters: [
          {
            name: "domain",
            in: "path",
            required: true,
            description: "The pattern, URL-encoded.",
            schema: { type: "string" },
          },
        ],
        requestBody: body("EgressCeilingFlagsBody"),
        responses: {
          "200": json("EgressCeilingEntryEnvelope", "The entry after the change."),
          "400": json("Error", "`invalid_request`."),
          "401": json("Error", "`unauthenticated`: no session."),
          "403": json("Error", "`forbidden`: not a site admin."),
          "404": json("Error", "`domain_not_found`."),
        },
      },
    },
  };
}

export function egressAccessOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    CreateEgressRequestBody: schemaOf(egressRequestCreateBodySchema, "input"),
    EgressRequestDecisionBody: schemaOf(decisionWithPatternBodySchema, "input"),
    EgressCeilingFlagsBody: schemaOf(ceilingFlagsBodySchema, "input"),
    EgressRequestEnvelope: schemaOf(z.object({ request: requestSchema }), "output"),
    EgressRequestList: schemaOf(z.object({ requests: z.array(requestSchema) }), "output"),
    SiteEgressRequestList: schemaOf(
      z.object({
        requests: z.array(
          requestSchema.extend({ team: z.object({ id: z.uuid(), name: z.string() }) }),
        ),
      }),
      "output",
    ),
    EgressRequestDecision: schemaOf(decisionResultSchema, "output"),
    EgressCeilingEntryEnvelope: schemaOf(z.object({ domain: ceilingEntrySchema }), "output"),
  };
}

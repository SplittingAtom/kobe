import { z } from "zod";
import {
  cursorSchema,
  kobeTool,
  page,
  segment,
  type BeforeState,
  type KobeRouteCaller,
} from "../catalog.js";

/**
 * Team console › Egress (`/v1/team/egress`, page permission `team.egress.manage`): the domains the
 * team's sandboxes may reach (within the site ceiling) and members' access requests. Injected
 * header names are for egress managers only (the route hides them from everyone else) and header
 * values never leave the server; setting or clearing headers stays in the console.
 */

/** A host or `*.parent` pattern; the route parses it fully. */
const domain = z
  .string()
  .min(1)
  .max(300)
  .regex(/^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/);

const domainRow = z.object({
  domain: z.string(),
  in_ceiling: z.boolean(),
  shared_hosting: z.boolean(),
  enabled: z.boolean(),
  header_names: z.array(z.string()),
});
const egressAnswer = z.object({ domains: z.array(domainRow) });

export const teamEgressList = kobeTool({
  name: "team_egress_list",
  title: "List the team's internet domains",
  description:
    "Lists the domains in the site's egress ceiling with whether the conversation's team enabled " +
    "each (Team console › Egress), shared hosting (CDN) flags and the names of injected headers " +
    "(never their values). Paged: pass next_cursor back as cursor.",
  scope: "team",
  permission: "team.egress.manage",
  readOnly: true,
  input: z.strictObject({ cursor: cursorSchema.optional() }),
  output: z.strictObject({
    domains: z
      .array(
        z.strictObject({
          domain: z.string().max(300),
          in_ceiling: z.boolean(),
          shared_hosting: z.boolean(),
          enabled: z.boolean(),
          header_names: z.array(z.string().max(100)).max(8),
        }),
      )
      .max(50),
    next_cursor: cursorSchema.optional(),
  }),
  route: () => ({ method: "GET", path: "/team/egress" }),
  reduce: (body, input) => {
    const { rows, next_cursor } = page(egressAnswer.parse(body).domains, input.cursor);
    return {
      domains: rows.map((d) => ({
        domain: d.domain.slice(0, 300),
        in_ceiling: d.in_ceiling,
        shared_hosting: d.shared_hosting,
        enabled: d.enabled,
        header_names: d.header_names.slice(0, 8).map((h) => h.slice(0, 100)),
      })),
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

async function domainOf(call: KobeRouteCaller, name: string) {
  const answer = await call({ method: "GET", path: "/team/egress" });
  if (answer.status !== 200) return "unreadable" as const;
  const parsed = egressAnswer.safeParse(answer.body);
  if (!parsed.success) return "unreadable" as const;
  return parsed.data.domains.find((d) => d.domain === name.toLowerCase());
}

export const teamEgressEnable = kobeTool({
  name: "team_egress_enable",
  title: "Enable a domain for the team",
  description:
    "Lets the conversation's team's sandboxes reach a domain of the site's egress ceiling (Team " +
    "console › Egress); pending access requests for it are approved with it. The domain must be " +
    "in the ceiling and not enabled now (team_egress_list). The person is always asked to " +
    "approve; never retry a refused or denied call.",
  scope: "team",
  permission: "team.egress.manage",
  readOnly: false,
  destructive: false,
  input: z.strictObject({ domain, from_enabled: z.literal(false) }),
  output: z.strictObject({ domain: z.string().max(300), enabled: z.literal(true) }),
  route: (input) => ({
    method: "PUT",
    path: `/team/egress/domains/${segment(input.domain)}`,
    query: { expected: "disabled" },
  }),
  reduce: (body) => {
    const parsed = z.object({ domain: z.string() }).parse(body);
    return { domain: parsed.domain.slice(0, 300), enabled: true as const };
  },
  before: async (input, call): Promise<BeforeState> => {
    const current = await domainOf(call, input.domain);
    if (current === "unreadable") return "changed";
    if (current === undefined || !current.in_ceiling) {
      return {
        code: "not_in_ceiling",
        message: "That domain is not in the site's egress ceiling. Ask a site admin.",
      };
    }
    return current.enabled ? "changed" : "same";
  },
  summary: (input) => `Let the team's sandboxes reach ${input.domain}`,
});

export const teamEgressDisable = kobeTool({
  name: "team_egress_disable",
  title: "Disable a domain for the team",
  description:
    "Stops the conversation's team's sandboxes reaching a domain (Team console › Egress); it can " +
    "be enabled again. A domain with injected headers is refused (disabling would delete their " +
    "values): that stays in the console. The person is always asked to approve; never retry a " +
    "refused or denied call.",
  scope: "team",
  permission: "team.egress.manage",
  readOnly: false,
  destructive: false,
  input: z.strictObject({ domain, from_enabled: z.literal(true) }),
  output: z.strictObject({ domain: z.string().max(300), enabled: z.literal(false) }),
  route: (input) => ({
    method: "DELETE",
    path: `/team/egress/domains/${segment(input.domain)}`,
    query: { expected: "enabled_without_headers" },
  }),
  reduce: (_body, input) => ({ domain: input.domain.toLowerCase(), enabled: false as const }),
  before: async (input, call): Promise<BeforeState> => {
    const current = await domainOf(call, input.domain);
    if (current === "unreadable") return "changed";
    if (current === undefined || !current.enabled) return "changed";
    if (current.header_names.length > 0) {
      return {
        code: "injected_headers",
        message:
          "The domain has injected headers, which disabling it would delete: do it in the Team console.",
      };
    }
    return "same";
  },
  summary: (input) => `Stop the team's sandboxes reaching ${input.domain}`,
});

const requestStatus = z.enum(["pending", "approved", "denied"]);
const requestRow = z.object({
  id: z.uuid(),
  domain: z.string(),
  pattern: z.string(),
  status: requestStatus,
  scope: z.string(),
  internal: z.boolean(),
  thread_id: z.uuid().nullable(),
  requested_by: z.object({ id: z.uuid(), name: z.string() }),
  created_at: z.string(),
  decided_at: z.string().nullable(),
});
const requestsAnswer = z.object({ requests: z.array(requestRow) });

export const teamEgressRequestsList = kobeTool({
  name: "team_egress_requests_list",
  title: "List internet access requests",
  description:
    "Lists members' requests to reach a domain (default pending): who asked, the domain and the " +
    "pattern it would enable, and whether team admins (scope team) or site admins (scope site) " +
    "decide it (Team console › Egress). Paged: pass next_cursor back as cursor.",
  scope: "team",
  permission: "team.egress.manage",
  readOnly: true,
  input: z.strictObject({
    status: z.enum(["pending", "approved", "denied", "all"]).optional(),
    cursor: cursorSchema.optional(),
  }),
  output: z.strictObject({
    requests: z
      .array(
        z.strictObject({
          request_id: z.uuid(),
          domain: z.string().max(300),
          pattern: z.string().max(300),
          status: requestStatus,
          scope: z.string().max(10),
          internal: z.boolean(),
          requested_by: z.strictObject({ user_id: z.uuid(), name: z.string().max(200) }),
          created_at: z.string().max(40),
          decided_at: z.string().max(40).nullable(),
        }),
      )
      .max(50),
    next_cursor: cursorSchema.optional(),
  }),
  route: (input) => ({
    method: "GET",
    path: "/team/egress/requests",
    query: { status: input.status ?? "pending" },
  }),
  reduce: (body, input) => {
    const { rows, next_cursor } = page(requestsAnswer.parse(body).requests, input.cursor);
    return {
      requests: rows.map((r) => ({
        request_id: r.id,
        domain: r.domain.slice(0, 300),
        pattern: r.pattern.slice(0, 300),
        status: r.status,
        scope: r.scope.slice(0, 10),
        internal: r.internal,
        requested_by: { user_id: r.requested_by.id, name: r.requested_by.name.slice(0, 200) },
        created_at: r.created_at,
        decided_at: r.decided_at,
      })),
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

export const teamEgressRequestsDecide = kobeTool({
  name: "team_egress_requests_decide",
  title: "Approve or deny an access request",
  description:
    "Approves (enables its pattern for the team, within the site ceiling) or denies a pending " +
    "team-scope access request (Team console › Egress). A decided request is refused " +
    "(already_decided). The person is always asked to approve; never retry a refused or denied " +
    "call.",
  scope: "team",
  permission: "team.egress.manage",
  readOnly: false,
  destructive: false,
  input: z.strictObject({
    request_id: z.uuid(),
    /** Only a pending request can be decided; the route refuses any other under its lock. */
    from_status: z.literal("pending"),
    decision: z.enum(["approve", "deny"]),
  }),
  output: z.strictObject({ request_id: z.uuid(), status: requestStatus }),
  route: (input) => ({
    method: "POST",
    path: `/team/egress/requests/${input.request_id}`,
    body: { decision: input.decision },
  }),
  reduce: (body, input) => {
    const parsed = z.object({ request: z.object({ status: requestStatus }) }).safeParse(body);
    return {
      request_id: input.request_id,
      status: parsed.success
        ? parsed.data.request.status
        : input.decision === "approve"
          ? ("approved" as const)
          : ("denied" as const),
    };
  },
  before: async (input, call): Promise<BeforeState> => {
    const answer = await call({
      method: "GET",
      path: "/team/egress/requests",
      query: { status: "all" },
    });
    const parsed = answer.status === 200 ? requestsAnswer.safeParse(answer.body) : undefined;
    if (!parsed?.success) return "changed";
    const current = parsed.data.requests.find((r) => r.id === input.request_id);
    if (current === undefined) {
      return { code: "request_not_found", message: "That request does not exist." };
    }
    return current.status === input.from_status ? "same" : "changed";
  },
  summary: (input) =>
    `${input.decision === "approve" ? "Approve" : "Deny"} internet access request ${input.request_id}`,
});

import { z } from "zod";
import { cursorSchema, kobeTool, page } from "../../catalog.js";
import { clip, matches, missing, querySchema, readAs } from "./shared.js";

/**
 * Site console › Egress (`/v1/site/egress-ceiling`, `site.egress.manage`, KOBE-622): the ceiling of
 * domains teams may enable, and the site-scope access requests. Deleting a ceiling domain and the
 * preset switches stay in the console; taking a domain out of the ceiling is `site_egress_ceiling_set`.
 */

const CEILING = { method: "GET", path: "/site/egress-ceiling" } as const;
const ceilingRow = z.object({
  domain: z.string(),
  preset: z.string().nullable(),
  in_ceiling: z.boolean(),
  internal: z.boolean(),
  note: z.string().nullable(),
  shared_hosting: z.boolean(),
});
const ceilingAnswer = z.object({ domains: z.array(ceilingRow) });
const ceilingOut = z.strictObject({
  domain: z.string().max(300),
  preset: z.string().max(40).nullable(),
  in_ceiling: z.boolean(),
  internal: z.boolean(),
  note: z.string().max(200).nullable(),
  shared_hosting: z.boolean(),
});
const toOut = (d: z.infer<typeof ceilingRow>) => ({
  domain: clip(d.domain, 300),
  preset: d.preset,
  in_ceiling: d.in_ceiling,
  internal: d.internal,
  note: d.note === null ? null : clip(d.note, 200),
  shared_hosting: d.shared_hosting,
});

/** A host or `*.parent` (the route normalises and validates it further); safe in a path. */
const domainSchema = z
  .string()
  .max(253)
  .regex(/^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/, "a host like example.com or *.example.com");

export const siteEgressCeilingList = kobeTool({
  name: "site_egress_ceiling_list",
  title: "List the egress ceiling",
  description:
    "Lists the site's egress ceiling: the domains teams may enable for their sandboxes, presets " +
    "included, whether each is in the ceiling, internal (same cluster) or on shared hosting (Site " +
    "console › Egress). Optional `query` filters by domain. Paged: pass next_cursor back as cursor.",
  scope: "site",
  permission: "site.egress.manage",
  readOnly: true,
  input: z.strictObject({ cursor: cursorSchema.optional(), query: querySchema.optional() }),
  output: z.strictObject({
    domains: z.array(ceilingOut).max(50),
    total: z.number().int(),
    next_cursor: cursorSchema.optional(),
  }),
  route: () => CEILING,
  reduce: (body, input) => {
    const all = ceilingAnswer.parse(body).domains.filter((d) => matches(input.query, d.domain));
    const { rows, next_cursor } = page(all, input.cursor);
    return {
      domains: rows.map(toOut),
      total: all.length,
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

export const siteEgressCeilingAdd = kobeTool({
  name: "site_egress_ceiling_add",
  title: "Add a domain to the egress ceiling",
  description:
    "Adds a domain (a host or *.parent) to the site's egress ceiling, so teams may enable it " +
    "(Site console › Egress); a listed domain that is out of the ceiling is put back in. It " +
    "warns when the domain is on shared hosting or a CDN. The person is always asked to approve; " +
    "never retry a refused or denied call.",
  scope: "site",
  permission: "site.egress.manage",
  readOnly: false,
  destructive: false,
  input: z.strictObject({
    domain: domainSchema,
    note: z
      .string()
      .trim()
      .max(200)
      .regex(/^[^\p{Cc}]*$/u)
      .optional(),
  }),
  output: z.strictObject({
    domain: ceilingOut,
    warnings: z.array(z.string().max(500)).max(5),
  }),
  route: (input) => ({
    method: "POST",
    path: "/site/egress-ceiling",
    body: { domain: input.domain, ...(input.note === undefined ? {} : { note: input.note }) },
  }),
  reduce: (body) => {
    const a = z.object({ domain: ceilingRow, warnings: z.array(z.string()) }).parse(body);
    return { domain: toOut(a.domain), warnings: a.warnings.slice(0, 5).map((w) => clip(w, 500)) };
  },
  // The before-state is "not in the ceiling"; the route refuses a domain already in it.
  before: async (input, call) => {
    const a = await readAs(call, CEILING, ceilingAnswer);
    const row = a?.domains.find((d) => d.domain === input.domain.toLowerCase());
    if (row?.in_ceiling === true) {
      return missing("already_in_ceiling", "That domain is already in the ceiling.");
    }
    return "same";
  },
  summary: (input) => `Add ${input.domain} to the site egress ceiling (teams may then enable it)`,
});

export const siteEgressCeilingSet = kobeTool({
  name: "site_egress_ceiling_set",
  title: "Put a domain in or out of the egress ceiling",
  description:
    "Puts a listed domain into the site's egress ceiling or takes it out (Site console › " +
    "Egress); out of the ceiling, no team can enable it and teams that did lose it. Give the " +
    "domain, whether it is in the ceiling now (from site_egress_ceiling_list) and the new value. " +
    "The person is always asked to approve; never retry a refused or denied call.",
  scope: "site",
  permission: "site.egress.manage",
  readOnly: false,
  destructive: false,
  input: z
    .strictObject({
      domain: domainSchema,
      from_in_ceiling: z.boolean(),
      to_in_ceiling: z.boolean(),
    })
    .refine((v) => v.from_in_ceiling !== v.to_in_ceiling, { message: "from and to are the same" }),
  output: z.strictObject({ domain: ceilingOut }),
  route: (input) => ({
    method: "PUT",
    path: `/site/egress-ceiling/${input.domain.toLowerCase()}`,
    body: { in_ceiling: input.to_in_ceiling, expected_in_ceiling: input.from_in_ceiling },
  }),
  reduce: (body) => ({ domain: toOut(z.object({ domain: ceilingRow }).parse(body).domain) }),
  before: async (input, call) => {
    const a = await readAs(call, CEILING, ceilingAnswer);
    if (a === undefined) return "changed";
    const row = a.domains.find((d) => d.domain === input.domain.toLowerCase());
    if (row === undefined) return missing("domain_not_found", "That domain is not listed.");
    return row.in_ceiling === input.from_in_ceiling ? "same" : "changed";
  },
  summary: (input) =>
    input.to_in_ceiling
      ? `Put ${input.domain} back into the site egress ceiling`
      : `Take ${input.domain} out of the site egress ceiling (no team can enable it)`,
});

const REQUEST_STATUS = z.enum(["pending", "approved", "denied"]);
const requestRow = z.object({
  id: z.uuid(),
  domain: z.string(),
  pattern: z.string(),
  status: REQUEST_STATUS,
  internal: z.boolean(),
  requested_by: z.object({ id: z.uuid(), name: z.string() }),
  created_at: z.string(),
  decided_at: z.string().nullable(),
  team: z.object({ id: z.uuid(), name: z.string() }),
});
const requestsAnswer = z.object({ requests: z.array(requestRow) });
const requestsRoute = (status: string) =>
  ({ method: "GET", path: "/site/egress-ceiling/requests", query: { status } }) as const;

export const siteEgressRequestsList = kobeTool({
  name: "site_egress_requests_list",
  title: "List site egress requests",
  description:
    "Lists the site-scope internet access requests across teams: domains outside the ceiling or " +
    "internal addresses, which only a site admin can decide (Site console › Egress › Requests). " +
    "`status` is pending (default), approved, denied or all. Paged: pass next_cursor back as cursor.",
  scope: "site",
  permission: "site.egress.manage",
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
          team_id: z.uuid(),
          team_name: z.string().max(100),
          domain: z.string().max(300),
          status: REQUEST_STATUS,
          internal: z.boolean(),
          requested_by: z.string().max(200),
          created_at: z.string().max(40),
        }),
      )
      .max(50),
    next_cursor: cursorSchema.optional(),
  }),
  route: (input) => requestsRoute(input.status ?? "pending"),
  reduce: (body, input) => {
    const { rows, next_cursor } = page(requestsAnswer.parse(body).requests, input.cursor);
    return {
      requests: rows.map((r) => ({
        request_id: r.id,
        team_id: r.team.id,
        team_name: clip(r.team.name, 100),
        domain: clip(r.domain, 300),
        status: r.status,
        internal: r.internal,
        requested_by: clip(r.requested_by.name, 200),
        created_at: r.created_at,
      })),
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

export const siteEgressRequestsDecide = kobeTool({
  name: "site_egress_requests_decide",
  title: "Decide a site egress request",
  description:
    "Approves or denies a pending site-scope internet access request (Site console › Egress › " +
    "Requests). Approving adds the pattern to the ceiling and enables it for the requesting " +
    "team; `pattern` may widen the host to *.parent; `internal` marks it same-cluster. Give the " +
    "team_id and request_id from site_egress_requests_list and from_status `pending`. The person " +
    "is always asked to approve; never retry a refused or denied call.",
  scope: "site",
  permission: "site.egress.manage",
  readOnly: false,
  destructive: false,
  input: z.strictObject({
    team_id: z.uuid(),
    request_id: z.uuid(),
    from_status: z.literal("pending"),
    decision: z.enum(["approve", "deny"]),
    pattern: domainSchema.optional(),
    internal: z.boolean().optional(),
  }),
  output: z.strictObject({
    request_id: z.uuid(),
    status: REQUEST_STATUS,
    pattern: z.string().max(300).nullable(),
  }),
  route: (input) => ({
    method: "POST",
    path: `/site/egress-ceiling/requests/${input.team_id}/${input.request_id}/decision`,
    body: {
      decision: input.decision,
      ...(input.pattern === undefined ? {} : { pattern: input.pattern }),
      ...(input.internal === undefined ? {} : { internal: input.internal }),
    },
  }),
  reduce: (body) => {
    const a = z
      .object({
        request: z.object({ id: z.uuid(), status: REQUEST_STATUS }),
        pattern: z.string().nullish(),
      })
      .parse(body);
    return {
      request_id: a.request.id,
      status: a.request.status,
      pattern: a.pattern == null ? null : clip(a.pattern, 300),
    };
  },
  // A decided request cannot be decided again (the route answers already_decided).
  before: async (input, call) => {
    const a = await readAs(call, requestsRoute("all"), requestsAnswer);
    if (a === undefined) return "changed";
    const r = a.requests.find((x) => x.id === input.request_id && x.team.id === input.team_id);
    if (r === undefined) return missing("request_not_found", "That request does not exist.");
    return r.status === input.from_status ? "same" : "changed";
  },
  summary: (input) =>
    `${input.decision === "approve" ? "Approve" : "Deny"} site egress request ${input.request_id}` +
    (input.decision === "approve" && input.pattern !== undefined ? ` as ${input.pattern}` : "") +
    (input.internal === true ? " (internal)" : ""),
});

import { z } from "zod";
import { kobeTool } from "../../catalog.js";
import { clip } from "./shared.js";

/**
 * Site console › Usage (`/v1/site/usage`, `site.usage.read`) and › Audit (`/v1/site/audit`,
 * `site.audit.read`) (KOBE-622): counts and costs, never team content; audit events never carry
 * the IP address or user agent (spec §5, §8). The export, forwarding health and integrity check stay
 * in the console.
 */

const totals = z.object({
  calls: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number(),
  unpriced_calls: z.number(),
});
const totalsOut = {
  calls: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number(),
  unpriced_calls: z.number(),
};
const pick = (t: z.infer<typeof totals>) => ({
  calls: t.calls,
  input_tokens: t.input_tokens,
  output_tokens: t.output_tokens,
  cost_usd: t.cost_usd,
  unpriced_calls: t.unpriced_calls,
});
const BREAKDOWN_MAX = 25;
const isoTime = z.iso.datetime({ offset: true });

export const siteUsageRead = kobeTool({
  name: "site_usage_read",
  title: "Read site usage",
  description:
    "Reads model usage and spend across every team for a time range (default the last 30 days; " +
    "`from`/`to` as ISO date-times, at most the console's range): totals, and the top teams and " +
    "models by cost (Site console › Usage). Counts and costs only, never conversation content.",
  scope: "site",
  permission: "site.usage.read",
  readOnly: true,
  input: z.strictObject({ from: isoTime.optional(), to: isoTime.optional() }),
  output: z.strictObject({
    from: z.string().max(40),
    to: z.string().max(40),
    totals: z.strictObject(totalsOut),
    by_team: z
      .array(
        z.strictObject({
          team_id: z.uuid(),
          name: z.string().max(100),
          ...totalsOut,
        }),
      )
      .max(BREAKDOWN_MAX),
    by_model: z
      .array(z.strictObject({ model: z.string().max(200), ...totalsOut }))
      .max(BREAKDOWN_MAX),
  }),
  route: (input) => ({
    method: "GET",
    path: "/site/usage",
    query: {
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    },
  }),
  reduce: (body) => {
    const a = z
      .object({
        range: z.object({ from: z.string(), to: z.string() }),
        totals,
        by_team: z.array(totals.extend({ team_id: z.uuid(), name: z.string() })),
        by_model: z.array(totals.extend({ model: z.string() })),
      })
      .parse(body);
    return {
      from: a.range.from,
      to: a.range.to,
      totals: pick(a.totals),
      by_team: a.by_team
        .slice(0, BREAKDOWN_MAX)
        .map((t) => ({ team_id: t.team_id, name: clip(t.name, 100), ...pick(t) })),
      by_model: a.by_model
        .slice(0, BREAKDOWN_MAX)
        .map((m) => ({ model: clip(m.model, 200), ...pick(m) })),
    };
  },
});

/** Keys that could carry a network address or client string: never shown to the model. */
const PRIVATE_KEY =
  /^(ip|ips|ipaddress|ip_address|useragent|user_agent|ua|remoteaddr|remote_addr)$/i;
const TARGET_MAX_CHARS = 1_000;

/** The event's target without any IP/UA-like key (at any depth), bounded. */
export function auditTarget(value: unknown, depth = 0): unknown {
  if (depth > 4) return null;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => auditTarget(v, depth + 1));
  if (typeof value === "string") return clip(value, 300);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !PRIVATE_KEY.test(k))
      .slice(0, 30)
      .map(([k, v]) => [k, auditTarget(v, depth + 1)]),
  );
}

function boundedTarget(value: unknown): Record<string, unknown> {
  const clean = auditTarget(value);
  const record =
    typeof clean === "object" && clean !== null ? (clean as Record<string, unknown>) : {};
  return JSON.stringify(record).length <= TARGET_MAX_CHARS ? record : { truncated: true };
}

const seqCursor = z.string().regex(/^\d{1,18}$/);
const auditRow = z.object({
  seq: z.number().int(),
  at: z.string(),
  teamId: z.uuid().nullable(),
  actor: z.object({
    kind: z.string(),
    id: z.string().nullable(),
    name: z.string().nullable(),
  }),
  action: z.string(),
  target: z.record(z.string(), z.unknown()),
});

export const siteAuditList = kobeTool({
  name: "site_audit_list",
  title: "Read the site audit log",
  description:
    "Reads the site-wide audit log, newest first (Site console › Audit): when, which team, who " +
    "(user, agent or system; target.viaAgent when a person acted through an agent), the action and " +
    "its target. Never the IP address or user agent. Filters: action (e.g. " +
    "identity.user.deactivated), category (e.g. identity), actor_id, team_id, since/until as ISO " +
    "date-times. `limit` up to 50. Paged: pass next_cursor back as cursor.",
  scope: "site",
  permission: "site.audit.read",
  readOnly: true,
  input: z.strictObject({
    cursor: seqCursor.optional(),
    limit: z.number().int().min(1).max(50).optional(),
    action: z
      .string()
      .max(80)
      .regex(/^[a-z_]+(\.[a-z_]+)*$/)
      .optional(),
    category: z
      .string()
      .max(40)
      .regex(/^[a-z_]+$/)
      .optional(),
    actor_id: z.uuid().optional(),
    team_id: z.uuid().optional(),
    since: isoTime.optional(),
    until: isoTime.optional(),
  }),
  output: z.strictObject({
    events: z
      .array(
        z.strictObject({
          seq: z.number().int(),
          at: z.string().max(40),
          team_id: z.uuid().nullable(),
          actor_kind: z.string().max(10),
          actor_id: z.string().max(64).nullable(),
          actor_name: z.string().max(200).nullable(),
          action: z.string().max(80),
          target: z.record(z.string(), z.unknown()),
        }),
      )
      .max(50),
    next_cursor: seqCursor.optional(),
  }),
  route: (input) => ({
    method: "GET",
    path: "/site/audit",
    query: {
      limit: String(input.limit ?? 50),
      ...(input.cursor === undefined ? {} : { before: input.cursor }),
      ...(input.action === undefined ? {} : { action: input.action }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.actor_id === undefined ? {} : { actorId: input.actor_id }),
      ...(input.team_id === undefined ? {} : { teamId: input.team_id }),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.until === undefined ? {} : { until: input.until }),
    },
  }),
  // Only the allowlisted fields are copied: ip, userAgent and the hash chain never leave here.
  reduce: (body) => {
    const a = z
      .object({ events: z.array(auditRow), nextCursor: z.string().nullable() })
      .parse(body);
    return {
      events: a.events.slice(0, 50).map((e) => ({
        seq: e.seq,
        at: e.at,
        team_id: e.teamId,
        actor_kind: e.actor.kind,
        actor_id: e.actor.id,
        actor_name: e.actor.name === null ? null : clip(e.actor.name, 200),
        action: clip(e.action, 80),
        target: boundedTarget(e.target),
      })),
      ...(a.nextCursor === null ? {} : { next_cursor: a.nextCursor }),
    };
  },
});

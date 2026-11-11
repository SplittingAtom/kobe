import { z } from "zod";
import { cursorSchema, kobeTool, KOBE_RESULT_MAX_BYTES } from "../catalog.js";

/**
 * Team console › Usage (`/v1/team/usage`, `team.budgets.manage`) and › Audit (`/v1/team/audit`,
 * `team.audit.read`). Audit results never carry the request's IP or user agent (nor the hash
 * chain); a page stops early when it would pass the result cap.
 */

const iso = z.iso.datetime({ offset: true });

const totals = z.object({
  calls: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  cost_usd: z.number(),
  unpriced_calls: z.number(),
});
const usageAnswer = z.object({
  range: z.object({ from: z.string(), to: z.string(), bucket: z.string() }),
  totals,
  by_user: z.array(totals.extend({ user_id: z.uuid(), name: z.string().nullable() })),
  by_model: z.array(totals.extend({ model: z.string() })),
  by_agent: z.array(totals.extend({ agent_id: z.uuid().nullable(), slug: z.string().nullable() })),
  by_kind: z.array(totals.extend({ kind: z.string() })),
});

const totalsOut = z.strictObject({
  calls: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_tokens: z.number(),
  cost_usd: z.number(),
  unpriced_calls: z.number(),
});
type Totals = z.infer<typeof totals>;
const compact = (t: Totals): z.infer<typeof totalsOut> => ({
  calls: t.calls,
  input_tokens: t.input_tokens,
  output_tokens: t.output_tokens,
  cache_tokens: t.cache_read_tokens + t.cache_write_tokens,
  cost_usd: t.cost_usd,
  unpriced_calls: t.unpriced_calls,
});
const BREAKDOWN = 20;

export const teamUsageGet = kobeTool({
  name: "team_usage_get",
  title: "Read the team's usage",
  description:
    "Reads the conversation's team model usage for a period (default the last 30 days; from and " +
    "to as ISO date-times, at most 400 days): totals and the top 20 by member, model, agent and " +
    "kind, with tokens and dollars (Team console › Usage).",
  scope: "team",
  permission: "team.budgets.manage",
  readOnly: true,
  input: z.strictObject({ from: iso.optional(), to: iso.optional() }),
  output: z.strictObject({
    range: z.strictObject({ from: z.string().max(40), to: z.string().max(40) }),
    totals: totalsOut,
    by_member: z
      .array(totalsOut.extend({ user_id: z.uuid(), name: z.string().max(200).nullable() }))
      .max(BREAKDOWN),
    by_model: z.array(totalsOut.extend({ model: z.string().max(200) })).max(BREAKDOWN),
    by_agent: z
      .array(
        totalsOut.extend({ agent_id: z.uuid().nullable(), slug: z.string().max(100).nullable() }),
      )
      .max(BREAKDOWN),
    by_kind: z.array(totalsOut.extend({ kind: z.string().max(40) })).max(BREAKDOWN),
  }),
  route: (input) => ({
    method: "GET",
    path: "/team/usage",
    query: {
      bucket: "day",
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    },
  }),
  reduce: (body) => {
    const u = usageAnswer.parse(body);
    return {
      range: { from: u.range.from.slice(0, 40), to: u.range.to.slice(0, 40) },
      totals: compact(u.totals),
      by_member: u.by_user.slice(0, BREAKDOWN).map((x) => ({
        ...compact(x),
        user_id: x.user_id,
        name: x.name?.slice(0, 200) ?? null,
      })),
      by_model: u.by_model
        .slice(0, BREAKDOWN)
        .map((x) => ({ ...compact(x), model: x.model.slice(0, 200) })),
      by_agent: u.by_agent.slice(0, BREAKDOWN).map((x) => ({
        ...compact(x),
        agent_id: x.agent_id,
        slug: x.slug?.slice(0, 100) ?? null,
      })),
      by_kind: u.by_kind
        .slice(0, BREAKDOWN)
        .map((x) => ({ ...compact(x), kind: x.kind.slice(0, 40) })),
    };
  },
});

const auditEvent = z.object({
  seq: z.number().int(),
  at: z.string(),
  actor: z.object({ kind: z.string(), id: z.string().nullable(), name: z.string().nullable() }),
  action: z.string(),
  target: z.record(z.string(), z.unknown()),
});
const auditAnswer = z.object({ events: z.array(auditEvent), nextCursor: z.string().nullable() });

const AUDIT_PAGE = 50;
/** Room left under the result cap for the envelope. */
const AUDIT_BUDGET = KOBE_RESULT_MAX_BYTES - 2048;
/** A request's address or client, should a target ever carry one (it does not today). */
const CLIENT_KEYS = /^(ip|ipAddress|ip_address|userAgent|user_agent)$/i;

/** An audit cursor: the last event's `seq` (base64url of a decimal); undefined when not one. */
export const seqCursor = {
  encode: (seq: number) => Buffer.from(String(seq), "utf8").toString("base64url"),
  decode: (cursor: string): number | undefined => {
    const n = Number(Buffer.from(cursor, "base64url").toString("utf8"));
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  },
};

const eventOut = z.strictObject({
  seq: z.number().int(),
  at: z.string().max(40),
  actor: z.strictObject({
    kind: z.string().max(20),
    id: z.string().max(64).nullable(),
    name: z.string().max(200).nullable(),
  }),
  action: z.string().max(100),
  target: z.record(z.string(), z.unknown()),
});

export const teamAuditList = kobeTool({
  name: "team_audit_list",
  title: "Read the team's audit log",
  description:
    "Reads the conversation's team audit log, newest first (Team console › Audit): who did what, " +
    "when, and to what; changes made through an agent carry target.viaAgent. Filter by action " +
    "(e.g. identity.member.role_changed), category (e.g. identity), actor_id, since and until. " +
    "Paged: pass next_cursor back as cursor.",
  scope: "team",
  permission: "team.audit.read",
  readOnly: true,
  input: z.strictObject({
    action: z
      .string()
      .max(100)
      .regex(/^[a-z_]+(\.[a-z_]+)*$/)
      .optional(),
    category: z
      .string()
      .max(40)
      .regex(/^[a-z_]+$/)
      .optional(),
    actor_id: z.uuid().optional(),
    since: iso.optional(),
    until: iso.optional(),
    cursor: cursorSchema.optional(),
  }),
  output: z.strictObject({
    events: z.array(eventOut).max(AUDIT_PAGE),
    next_cursor: cursorSchema.optional(),
  }),
  route: (input) => ({
    method: "GET",
    path: "/team/audit",
    query: {
      limit: String(AUDIT_PAGE),
      ...(input.cursor === undefined || seqCursor.decode(input.cursor) === undefined
        ? {}
        : { before: String(seqCursor.decode(input.cursor)) }),
      ...(input.action === undefined ? {} : { action: input.action }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.actor_id === undefined ? {} : { actorId: input.actor_id }),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.until === undefined ? {} : { until: input.until }),
    },
  }),
  reduce: (body) => {
    const answer = auditAnswer.parse(body);
    const events: z.infer<typeof eventOut>[] = [];
    let size = 0;
    for (const e of answer.events.slice(0, AUDIT_PAGE)) {
      const event = {
        seq: e.seq,
        at: e.at.slice(0, 40),
        actor: {
          kind: e.actor.kind.slice(0, 20),
          id: e.actor.id?.slice(0, 64) ?? null,
          name: e.actor.name?.slice(0, 200) ?? null,
        },
        action: e.action.slice(0, 100),
        target: Object.fromEntries(Object.entries(e.target).filter(([k]) => !CLIENT_KEYS.test(k))),
      };
      size += Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
      if (size > AUDIT_BUDGET && events.length > 0) break;
      events.push(event);
    }
    const last = events.at(-1);
    const more = events.length < answer.events.length || answer.nextCursor !== null;
    return {
      events,
      ...(more && last !== undefined ? { next_cursor: seqCursor.encode(last.seq) } : {}),
    };
  },
});

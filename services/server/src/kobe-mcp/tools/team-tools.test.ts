import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  KOBE_PAGE_MAX,
  KOBE_RESULT_MAX_BYTES,
  isWriteTool,
  zodOf,
  type KobeRouteCaller,
} from "../catalog.js";
import { KOBE_ADMIN_TOOLS, kobeToolByName } from "./index.js";
import { seqCursor } from "./team-reports.js";

/** Unit checks of the Team console tools (KOBE-621, spec kobe-admin-mcp §5, KA-4). */

const ID = "00000000-0000-4000-8000-000000000001";
/** Site tools have their own unit checks (`kobe-mcp/site-tools.test.ts`, KOBE-622). */
const TEAM_WRITES = KOBE_ADMIN_TOOLS.filter(isWriteTool).filter((t) => t.scope === "team");
const ID2 = "00000000-0000-4000-8000-000000000002";
const tool = (name: string) => {
  const t = kobeToolByName(name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const answer =
  (body: unknown, status = 200): KobeRouteCaller =>
  () =>
    Promise.resolve({ status, body });

/** Writes whose route refuses another state itself (a pending request only) instead of a flag. */
const NATURALLY_CONDITIONAL = new Set(["team_egress_requests_decide"]);

const TEAM_TOOLS = [
  "team_members_list",
  "team_members_set_role",
  "team_members_remove",
  "team_invites_list",
  "team_invites_create",
  "team_invites_revoke",
  "team_connectors_list",
  "team_connectors_set_exposure",
  "team_connectors_disable",
  "team_skills_installs_list",
  "team_skill_reviews_list",
  "team_skill_reviews_decide",
  "team_models_list",
  "team_models_set",
  "team_budgets_get",
  "team_budgets_set_team",
  "team_budgets_set_member",
  "team_memory_get",
  "team_memory_set",
  "team_egress_list",
  "team_egress_enable",
  "team_egress_disable",
  "team_egress_requests_list",
  "team_egress_requests_decide",
  "team_agents_list",
  "team_agents_suspend",
  "team_agents_resume",
  "team_schedules_list",
  "team_schedules_pause",
  "team_schedules_resume",
  "team_usage_get",
  "team_audit_list",
];

/** Console-only (KA8 and §9): no tool may exist for these. */
const NEVER = /break_glass|ownership|site_roles|legal_hold|retention|transfer|headers|delete|purge/;

describe("the Team console tool list (KA-4)", () => {
  it("is exactly the §5 Team list, scope team, nothing console-only", () => {
    const team = KOBE_ADMIN_TOOLS.filter((t) => t.scope === "team").map((t) => t.name);
    expect(team.sort()).toEqual([...TEAM_TOOLS].sort());
    expect(team.filter((n) => NEVER.test(n))).toEqual([]);
  });

  it("every write names its before-state and carries it to the route as a condition", () => {
    for (const t of TEAM_WRITES) {
      const shape = JSON.stringify(zodOf(t.input).def);
      expect(shape, t.name).toMatch(/"from(_[a-z]+)?"/);
      if (NATURALLY_CONDITIONAL.has(t.name)) continue;
      // The route call (body or query) holds the approved before-state.
      const route = JSON.stringify(t.route(t.input.parse(sampleOf(t.name))));
      expect(route, t.name).toMatch(/expected/i);
    }
  });

  it("every read is listed as read-only and every list caps its rows at 50", () => {
    for (const t of KOBE_ADMIN_TOOLS.filter((x) => x.readOnly)) {
      const schema = z.toJSONSchema(zodOf(t.output), { unrepresentable: "any" }) as {
        properties: Record<string, { type?: string; maxItems?: number }>;
      };
      for (const [key, prop] of Object.entries(schema.properties)) {
        if (prop.type !== "array") continue;
        expect(prop.maxItems, `${t.name}.${key}`).toBeLessThanOrEqual(KOBE_PAGE_MAX);
      }
    }
  });

  it("builds every write's card summary from the input only", () => {
    for (const t of TEAM_WRITES) {
      const text = t.summary(t.input.parse(sampleOf(t.name)));
      expect(text.length, t.name).toBeGreaterThan(5);
      expect(text.length, t.name).toBeLessThan(400);
    }
  });

  it("a write whose current state is unreadable counts as changed", async () => {
    for (const t of TEAM_WRITES) {
      expect(await t.before(t.input.parse(sampleOf(t.name)), answer({}, 403)), t.name).toBe(
        "changed",
      );
    }
  });
});

describe("before-state checks per family", () => {
  it("members: removal compares the role, a departed member is not_a_member", async () => {
    const t = tool("team_members_remove");
    if (!isWriteTool(t)) throw new Error("write");
    const input = { user_id: ID, from_role: "member" };
    const members = (role: string) =>
      answer({ members: [{ userId: ID, name: "A", email: "a@x", role }] });
    expect(await t.before(input, members("member"))).toBe("same");
    expect(await t.before(input, members("team_admin"))).toBe("changed");
    expect(await t.before(input, answer({ members: [] }))).toMatchObject({ code: "not_a_member" });
    expect(t.route(input)).toMatchObject({ query: { expectedRole: "member" } });
  });

  it("invites: create compares the address's invitation (none or its role), case-insensitively", async () => {
    const t = tool("team_invites_create");
    if (!isWriteTool(t)) throw new Error("write");
    const invites = (role?: string) =>
      answer({
        invitations:
          role === undefined
            ? []
            : [
                {
                  id: ID,
                  email: "ana@example.com",
                  role,
                  invitedBy: { id: ID2, name: "B" },
                  createdAt: "x",
                  expiresAt: "y",
                  status: "pending",
                },
              ],
      });
    const fresh = { email: "Ana@Example.com", role: "member", from_role: null };
    expect(await t.before(fresh, invites())).toBe("same");
    expect(await t.before(fresh, invites("member"))).toBe("changed");
    const renew = { ...fresh, role: "team_admin", from_role: "member" };
    expect(await t.before(renew, invites("member"))).toBe("same");
    expect(t.route(t.input.parse(renew))).toMatchObject({ body: { expectedRole: "member" } });
    expect(t.summary(t.input.parse(renew))).toContain("Member → Team admin");
  });

  it("connectors: off means not enabled; custom needs its tools", async () => {
    const t = tool("team_connectors_set_exposure");
    if (!isWriteTool(t)) throw new Error("write");
    const row = (exposure: string | null) =>
      answer({
        connectors: [
          {
            id: ID,
            name: "c",
            auth_kind: "none",
            credential_source: "member",
            status: "active",
            enabled: exposure !== null,
            exposure,
            enabled_tools: [],
            tools: [],
          },
        ],
      });
    const input = { connector_id: ID, from_exposure: "off", to_exposure: "all" };
    expect(await t.before(input, row(null))).toBe("same");
    expect(await t.before(input, row("read_only"))).toBe("changed");
    expect(await t.before({ ...input, connector_id: ID2 }, row(null))).toMatchObject({
      code: "connector_not_found",
    });
    expect(t.input.safeParse({ ...input, to_exposure: "custom" }).success).toBe(false);
    expect(t.route(t.input.parse(input))).toMatchObject({
      body: { exposure: "all", expected_exposure: "off" },
    });
  });

  it("models: the whole setting must match", async () => {
    const t = tool("team_models_set");
    if (!isWriteTool(t)) throw new Error("write");
    const models = (enabled: boolean, isDefault: boolean) =>
      answer({
        models: [{ alias: "m-1", label: null, enabled, is_default: isDefault, thinking_max: null }],
      });
    const input = t.input.parse({
      alias: "m-1",
      from: { enabled: true, is_default: false, thinking_max: null },
      to: { enabled: true, is_default: true },
    });
    expect(await t.before(input, models(true, false))).toBe("same");
    expect(await t.before(input, models(true, true))).toBe("changed");
    expect(t.route(input).body).toMatchObject({ expected: { enabled: true, is_default: false } });
  });

  it("budgets: amounts compare to the cent; a member without a budget is null", async () => {
    const t = tool("team_budgets_set_member");
    if (!isWriteTool(t)) throw new Error("write");
    const spent = { month_usd: 0, day_usd: 0, month_tokens: 0, day_tokens: 0 };
    const none = { monthly_usd: null, daily_usd: null, monthly_tokens: null, daily_tokens: null };
    const view = (members: unknown[]) =>
      answer({
        period: { month: "m", day: "d" },
        team: { ...none, user_requests_per_minute: null, spent, member_default: none },
        effective_requests_per_minute: 60,
        members,
        eval_cap: { usd: null, tokens: null },
      });
    const amounts = { ...none, monthly_usd: 12.5 };
    const input = { user_id: ID, from: null, to: amounts };
    expect(await t.before(input, view([]))).toBe("same");
    const row = { user_id: ID, name: "A", email: "a@x", ...none, monthly_usd: 12.5, spent };
    expect(await t.before(input, view([row]))).toBe("changed");
    expect(await t.before({ ...input, from: amounts }, view([row]))).toBe("same");
    // Removing goes to DELETE with the approved budget as its condition.
    expect(t.route({ user_id: ID, from: amounts, to: null })).toMatchObject({
      method: "DELETE",
      body: { expected: amounts },
    });
  });

  it("egress: disabling refuses a domain with injected headers (their values would be lost)", async () => {
    const t = tool("team_egress_disable");
    if (!isWriteTool(t)) throw new Error("write");
    const domains = (headers: string[]) =>
      answer({
        domains: [
          {
            domain: "api.example.com",
            in_ceiling: true,
            shared_hosting: false,
            enabled: true,
            header_names: headers,
          },
        ],
      });
    const input = { domain: "api.example.com", from_enabled: true };
    expect(await t.before(input, domains([]))).toBe("same");
    expect(await t.before(input, domains(["X-Token"]))).toMatchObject({ code: "injected_headers" });
    expect(t.route(input)).toMatchObject({ query: { expected: "enabled_without_headers" } });
    // A wildcard domain is a percent-encoded path segment.
    expect(
      tool("team_egress_enable").route({ domain: "*.example.com", from_enabled: false }).path,
    ).toBe("/team/egress/domains/%2A.example.com");
  });

  it("schedules and agents: pause and suspend take only the opposite state", () => {
    expect(
      tool("team_schedules_pause").input.safeParse({ schedule_id: ID, from_active: false }).success,
    ).toBe(false);
    expect(
      tool("team_agents_resume").input.safeParse({ agent_id: ID, from_suspended: false }).success,
    ).toBe(false);
    expect(
      tool("team_agents_suspend").route({ agent_id: ID, from_suspended: false }),
    ).toMatchObject({
      query: { expectedSuspended: "false" },
      body: { state: "suspended" },
    });
  });
});

describe("results stay compact (ac-4)", () => {
  it("skill reviews never return the skill's text (finding excerpts)", () => {
    const t = tool("team_skill_reviews_list");
    const out = t.reduce(
      {
        reviews: [
          {
            skillId: ID,
            slug: "s",
            version: 1,
            semver: "1.0.0",
            scope: "team",
            unscanned: false,
            status: "pending",
            flagged: true,
            verdict: "caution",
            findingsDigest: "a".repeat(64),
            findings: [
              { category: "c", rule: "r", file: "f", line: 1, excerpt: "IGNORE ALL PREVIOUS" },
            ],
            blocked: false,
            suspended: false,
          },
        ],
        nextCursor: null,
      },
      {},
    );
    expect(JSON.stringify(out)).not.toContain("IGNORE");
    expect(() => t.output.parse(out)).not.toThrow();
  });

  it("audit pages drop client fields, stop under the cap and return a seq cursor", () => {
    const t = tool("team_audit_list");
    const big = "x".repeat(4000);
    const events = Array.from({ length: 50 }, (_, i) => ({
      seq: 1000 - i,
      at: "2026-11-11T00:00:00.000Z",
      actor: { kind: "user", id: ID, name: "A", email: "a@x" },
      action: "identity.member.role_changed",
      target: { userId: ID, note: big, ip: "10.0.0.1", userAgent: "UA" },
      ip: "10.0.0.1",
      userAgent: "UA",
      prevHash: "p",
      hash: "h",
    }));
    const out = t.output.parse(t.reduce({ events, nextCursor: "951" }, {})) as {
      events: { seq: number; target: Record<string, unknown> }[];
      next_cursor?: string;
    };
    const text = JSON.stringify(out);
    expect(Buffer.byteLength(text)).toBeLessThan(KOBE_RESULT_MAX_BYTES);
    expect(text).not.toMatch(/10\.0\.0\.1|"UA"|prevHash|email/);
    expect(out.events.length).toBeLessThan(50);
    const last = out.events.at(-1)?.seq;
    expect(seqCursor.decode(out.next_cursor ?? "")).toBe(last);
    // The cursor goes back to the route as `before`, beyond a million rows too.
    expect(t.route({ cursor: seqCursor.encode(5_000_000) })).toMatchObject({
      query: { before: "5000000", limit: "50" },
    });
  });

  it("egress lists pass header names through (the route hides them from non-managers)", () => {
    const t = tool("team_egress_list");
    const out = t.reduce(
      {
        domains: [
          {
            domain: "api.example.com",
            in_ceiling: true,
            shared_hosting: false,
            enabled: true,
            header_names: ["X-Token"],
            headers_updated_at: "t",
          },
        ],
      },
      {},
    );
    expect(out).toMatchObject({ domains: [{ header_names: ["X-Token"] }] });
  });
});

function sampleOf(name: string): unknown {
  const AMOUNTS = { monthly_usd: 10, daily_usd: null, monthly_tokens: null, daily_tokens: null };
  const samples: Record<string, unknown> = {
    team_members_set_role: { user_id: ID, from_role: "member", to_role: "contributor" },
    team_members_remove: { user_id: ID, from_role: "member" },
    team_invites_create: { email: "a@example.com", role: "member", from_role: null },
    team_invites_revoke: { invitation_id: ID, from_role: "member" },
    team_connectors_set_exposure: { connector_id: ID, from_exposure: "off", to_exposure: "all" },
    team_connectors_disable: { connector_id: ID, from_exposure: "all" },
    team_skill_reviews_decide: {
      skill_id: ID,
      version: 1,
      from_status: "pending",
      decision: "approve",
    },
    team_models_set: {
      alias: "m-1",
      from: { enabled: false, is_default: false, thinking_max: null },
      to: { enabled: true },
    },
    team_budgets_set_team: {
      from: { ...AMOUNTS, monthly_usd: null, user_requests_per_minute: null },
      to: { monthly_usd: 10 },
    },
    team_budgets_set_member: { user_id: ID, from: null, to: AMOUNTS },
    team_memory_set: {
      from: { memory_enabled: true, project_memory_enabled: true },
      to: { memory_enabled: false },
    },
    team_egress_enable: { domain: "*.example.com", from_enabled: false },
    team_egress_disable: { domain: "example.com", from_enabled: true },
    team_egress_requests_decide: { request_id: ID, from_status: "pending", decision: "approve" },
    team_agents_suspend: { agent_id: ID, from_suspended: false },
    team_agents_resume: { agent_id: ID, from_suspended: true },
    team_schedules_pause: { schedule_id: ID, from_active: true },
    team_schedules_resume: { schedule_id: ID, from_active: false },
  };
  if (!(name in samples)) throw new Error(`no sample for ${name}`);
  return samples[name];
}

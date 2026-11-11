import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyAuditChain } from "@kobe/db";
import { isWriteTool, type KobeTool } from "./kobe-mcp/catalog.js";
import { KOBE_ADMIN_TOOLS, kobeToolByName } from "./kobe-mcp/tools/index.js";
import { KobeMcpHarness, type KobeWorld } from "./testing/kobe-mcp-harness.js";

/**
 * The Team console tools end to end (KOBE-621, spec kobe-admin-mcp §5, KA-4): every tool through
 * the real MCP proxy and internal listener on a real Postgres. ac-1: without the console page's
 * permission a tool is not listed and a forged call is refused like a 403, even approved; with it,
 * listed and it works. ac-2: each write records the console's own audit event, the person "via
 * agent". ac-3: egress header names stay with egress managers. ac-4: results paged and capped.
 * Writes also carry their before-state into the route, which refuses a stale one itself.
 */
const h = new KobeMcpHarness();
const fx = h.fx;

beforeAll(() => h.setup());
afterAll(() => h.teardown());
beforeEach(() => h.reset());

const tool = (name: string): KobeTool => {
  const t = kobeToolByName(name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const short = () => randomUUID().slice(0, 8);
const NONE = { monthly_usd: null, daily_usd: null, monthly_tokens: null, daily_tokens: null };

// ── fixtures (as the superuser, like the other db tests) ──────────────────────────────────────

async function connector(): Promise<string> {
  const { rows } = await fx.admin.query<{ id: string }>(
    `INSERT INTO connectors (name, url, auth_kind) VALUES ($1, 'https://mcp.example.com/mcp', 'none')
     RETURNING id`,
    [`c-${short()}`],
  );
  return rows[0]?.id ?? "";
}

async function enabledConnector(w: KobeWorld): Promise<string> {
  const id = await connector();
  await fx.admin.query(
    `INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by) VALUES ($1, $2, 'all', $3)`,
    [w.team, id, w.admin.id],
  );
  return id;
}

async function invitation(w: KobeWorld, email = `i-${short()}@example.com`): Promise<string> {
  const { rows } = await fx.admin.query<{ id: string }>(
    `INSERT INTO team_invitations (team_id, email, role, invited_by, expires_at)
     VALUES ($1, $2, 'member', $3, now() + interval '14 days') RETURNING id`,
    [w.team, email, w.admin.id],
  );
  return rows[0]?.id ?? "";
}

async function review(w: KobeWorld, status = "pending"): Promise<{ skillId: string }> {
  const skillId = randomUUID();
  await fx.admin.query(
    `INSERT INTO team_skill_reviews (team_id, skill_id, version, scope, slug, content_hash, status,
       flagged, findings, scripts, skipped, scanned_at)
     VALUES ($1, $2, 1, 'team', $3, $4, $5::skill_review_status, false, '[]', '[]', '[]', now())`,
    [w.team, skillId, `s-${short()}`, randomUUID().replace(/-/g, ""), status],
  );
  return { skillId };
}

async function model(w: KobeWorld): Promise<string> {
  const provider = `p${short()}`;
  const alias = `m-${short()}`;
  await fx.admin.query(
    `INSERT INTO model_providers (id, kind, name, base_url, created_by)
     VALUES ($1, 'openai_compatible', $1, 'https://vllm.example', $2)`,
    [provider, w.admin.id],
  );
  await fx.admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by) VALUES ($1, $2, 'fake', $3)`,
    [alias, provider, w.admin.id],
  );
  return alias;
}

async function ceiling(domain = `api-${short()}.example.com`): Promise<string> {
  await fx.admin.query(
    `INSERT INTO egress_domains (domain, in_ceiling) VALUES ($1, true) ON CONFLICT DO NOTHING`,
    [domain],
  );
  return domain;
}

async function enabledDomain(w: KobeWorld, headers: readonly string[] = []): Promise<string> {
  const domain = await ceiling();
  await fx.admin.query(
    `INSERT INTO team_egress (team_id, domain, enabled_by, header_names, headers_sealed)
     VALUES ($1, $2, $3, $4, $5)`,
    [w.team, domain, w.admin.id, headers, headers.length > 0 ? "v2.test.sealed" : null],
  );
  return domain;
}

async function egressRequest(w: KobeWorld): Promise<string> {
  const domain = await ceiling();
  const { rows } = await fx.admin.query<{ id: string }>(
    `INSERT INTO egress_requests (team_id, domain, pattern, requested_by) VALUES ($1, $2, $2, $3)
     RETURNING id`,
    [w.team, domain, w.member.id],
  );
  return rows[0]?.id ?? "";
}

/** A published team-owned agent. */
async function teamAgent(w: KobeWorld, status = "active"): Promise<string> {
  const agent = randomUUID();
  const fm = JSON.stringify({ name: "Helper" });
  await fx.admin.query(
    `INSERT INTO team_agents (team_id, id, slug, frontmatter, owner_user_id, status)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::agent_status)`,
    [w.team, agent, `helper-${short()}`, fm, w.admin.id, status],
  );
  await fx.admin.query(
    `INSERT INTO team_agent_versions (team_id, agent_id, version, frontmatter, prompt,
       tool_manifest, published_by, skill_manifest, draft_revision)
     VALUES ($1, $2, 1, $3::jsonb, 'p', '{}', $4, '{"skills": []}', 1)`,
    [w.team, agent, fm, w.admin.id],
  );
  await fx.admin.query(
    `UPDATE team_agents SET current_version = 1 WHERE team_id = $1 AND id = $2`,
    [w.team, agent],
  );
  return agent;
}

async function schedule(w: KobeWorld, active: boolean, agentId?: string): Promise<string> {
  const id = randomUUID();
  await fx.admin.query(
    `INSERT INTO schedules (team_id, id, user_id, agent_id, prompt, recurrence, tz, active,
       next_due_at, paused_by)
     VALUES ($1, $2, $3, $4, 'secret prompt', '{"kind":"daily","at":"09:00"}', 'UTC', $5,
       CASE WHEN $5 THEN now() + interval '1 day' END, CASE WHEN $5 THEN NULL ELSE 'team_admin' END)`,
    [w.team, id, w.target.id, agentId ?? randomUUID(), active],
  );
  return id;
}

// ── the cases ──────────────────────────────────────────────────────────────────────────────────

interface Case {
  /** Arranges the target and returns the tool's input (reads: {} by default). */
  readonly arrange?: (w: KobeWorld) => Promise<Record<string, unknown>>;
  /** Writes: the console's own audit event. */
  readonly audit?: string;
  /** Writes: the route's own refusal of the now stale before-state (default the conditional). */
  readonly stale?: string;
  /** Writes: the tool's own pre-check answer to the replay (default changed_since_approval). */
  readonly replay?: string;
}

const CASES: Readonly<Record<string, Case>> = {
  team_members_list: {},
  team_members_set_role: {
    arrange: (w) =>
      Promise.resolve({ user_id: w.target.id, from_role: "member", to_role: "contributor" }),
    audit: "identity.member.role_changed",
  },
  team_members_remove: {
    arrange: (w) => Promise.resolve({ user_id: w.target.id, from_role: "member" }),
    audit: "identity.member.removed",
    stale: "not_a_member",
    replay: "not_a_member",
  },
  team_invites_list: { arrange: async (w) => (await invitation(w), {}) },
  team_invites_create: {
    arrange: () =>
      Promise.resolve({ email: `n-${short()}@example.com`, role: "contributor", from_role: null }),
    audit: "identity.team_invitation.created",
  },
  team_invites_revoke: {
    arrange: async (w) => ({ invitation_id: await invitation(w), from_role: "member" }),
    audit: "identity.team_invitation.revoked",
    stale: "invitation_not_found",
    replay: "invitation_not_found",
  },
  team_connectors_list: { arrange: async () => (await connector(), {}) },
  team_connectors_set_exposure: {
    arrange: async () => ({
      connector_id: await connector(),
      from_exposure: "off",
      to_exposure: "read_only",
    }),
    audit: "mcp.connector.team_changed",
  },
  team_connectors_disable: {
    arrange: async (w) => ({ connector_id: await enabledConnector(w), from_exposure: "all" }),
    audit: "mcp.connector.team_changed",
    stale: "not_enabled",
  },
  team_skills_installs_list: {},
  team_skill_reviews_list: { arrange: async (w) => (await review(w), {}) },
  team_skill_reviews_decide: {
    arrange: async (w) => ({
      skill_id: (await review(w)).skillId,
      version: 1,
      from_status: "pending",
      decision: "approve",
    }),
    audit: "skill.reviewed",
  },
  team_models_list: { arrange: async (w) => (await model(w), {}) },
  team_models_set: {
    arrange: async (w) => ({
      alias: await model(w),
      from: { enabled: false, is_default: false, thinking_max: null },
      to: { enabled: true, is_default: true },
    }),
    audit: "models.team.changed",
  },
  team_budgets_get: {},
  team_budgets_set_team: {
    arrange: () =>
      Promise.resolve({
        from: { ...NONE, user_requests_per_minute: null },
        to: { monthly_usd: 125.5, user_requests_per_minute: 20 },
      }),
    audit: "models.budget.changed",
  },
  team_budgets_set_member: {
    arrange: (w) =>
      Promise.resolve({ user_id: w.target.id, from: null, to: { ...NONE, daily_tokens: 5000 } }),
    audit: "models.budget.changed",
  },
  team_memory_get: {},
  team_memory_set: {
    arrange: () =>
      Promise.resolve({
        from: { memory_enabled: true, project_memory_enabled: true },
        to: { project_memory_enabled: false },
      }),
    audit: "memory.settings_changed",
  },
  team_egress_list: { arrange: async (w) => (await enabledDomain(w), {}) },
  team_egress_enable: {
    arrange: async () => ({ domain: await ceiling(), from_enabled: false }),
    audit: "egress.domain.enabled",
  },
  team_egress_disable: {
    arrange: async (w) => ({ domain: await enabledDomain(w), from_enabled: true }),
    audit: "egress.domain.disabled",
    stale: "domain_not_found",
  },
  team_egress_requests_list: { arrange: async (w) => (await egressRequest(w), {}) },
  team_egress_requests_decide: {
    arrange: async (w) => ({
      request_id: await egressRequest(w),
      from_status: "pending",
      decision: "approve",
    }),
    audit: "egress.request.decided",
    stale: "already_decided",
  },
  team_agents_list: { arrange: async (w) => (await teamAgent(w), {}) },
  team_agents_suspend: {
    arrange: async (w) => ({ agent_id: await teamAgent(w), from_suspended: false }),
    audit: "agent.status_changed",
  },
  team_agents_resume: {
    arrange: async (w) => ({ agent_id: await teamAgent(w, "suspended"), from_suspended: true }),
    audit: "agent.status_changed",
  },
  team_schedules_list: { arrange: async (w) => (await schedule(w, true), {}) },
  team_schedules_pause: {
    arrange: async (w) => ({ schedule_id: await schedule(w, true), from_active: true }),
    audit: "schedule.deactivated",
  },
  team_schedules_resume: {
    arrange: async (w) => ({
      schedule_id: await schedule(w, false, await teamAgent(w)),
      from_active: false,
    }),
    audit: "schedule.activated",
  },
  team_usage_get: {},
  team_audit_list: {},
};

const lastAudit = async (team: string, action: string) => {
  const { rows } = await fx.admin.query<{
    actor_kind: string;
    actor_id: string;
    target: Record<string, unknown>;
    ip: string | null;
    seq: string;
  }>(
    `SELECT actor_kind, actor_id, target, ip, seq FROM audit_log
      WHERE team_id = $1 AND action = $2 ORDER BY seq DESC LIMIT 1`,
    [team, action],
  );
  return rows[0];
};

const teamTools = KOBE_ADMIN_TOOLS.filter((t) => t.scope === "team");

describe("every Team console tool (ac-1, ac-2)", () => {
  it("has a case", () => {
    expect(teamTools.map((t) => t.name).filter((n) => !(n in CASES))).toEqual([]);
  });

  it.each(teamTools.map((t) => [t.name, t] as const))(
    "%s: hidden and refused without the permission; listed and working with it",
    async (name, t) => {
      const c = CASES[name] ?? {};
      const w = await h.world();
      const input = (await c.arrange?.(w)) ?? {};
      expect(t.input.safeParse(input).success, JSON.stringify(input)).toBe(true);

      // Without the page's permission: not listed, a forged call refused like a 403, even approved.
      const m = await h.sandboxFor(w.team, w.member);
      expect(await h.listNames(m)).not.toContain(name);
      if (isWriteTool(t)) await h.approve(m, name, input);
      const forged = await h.call(m, name, input);
      expect(forged.isError, forged.text).toBe(true);
      expect(forged.text).toContain("not available to you");
      // The route itself refuses an outsider, and a member's write.
      const route = t.route(t.input.parse(input));
      const outsider = await fx.person(`ko${short()}`);
      const strangers = await h.routesAs(w.team, outsider).catch(() => undefined);
      if (strangers) expect([401, 403]).toContain((await strangers(route)).status);
      if (isWriteTool(t)) {
        const asMember = await h.routesAs(w.team, w.member);
        expect([403, 404], name).toContain((await asMember(route)).status);
      }

      // With it: listed, and it works.
      const s = await h.sandboxFor(w.team, w.admin);
      expect(await h.listNames(s)).toContain(name);
      const before = await fx.admin.query<{ n: string }>(
        `SELECT coalesce(max(seq), 0)::text AS n FROM audit_log`,
      );
      const { out, toolCallId } = isWriteTool(t)
        ? await h.approvedCall(s, name, input).then((r) => ({
            out: r.out,
            toolCallId: r.approval.toolCallId,
          }))
        : { out: await h.call(s, name, input), toolCallId: undefined };
      expect(out.isError, out.text).toBeUndefined();
      expect(() => t.output.parse(out.structured)).not.toThrow();
      expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(64 * 1024);
      if (!isWriteTool(t)) return;

      // ac-2: the console's own event, the person via agent, no client address.
      const event = await lastAudit(w.team, c.audit ?? "");
      expect(event, c.audit).toBeDefined();
      expect(BigInt(event?.seq ?? 0)).toBeGreaterThan(BigInt(before.rows[0]?.n ?? 0));
      expect(event).toMatchObject({
        actor_kind: "user",
        actor_id: w.admin.id,
        ip: null,
        target: { viaAgent: { runId: s.runId, threadId: s.threadId, toolCallId } },
      });

      // The before-state is stale now: the route refuses it under its own lock (409), and the
      // tool says so before even calling it.
      const admin = await h.routesAs(w.team, w.admin);
      const again = await admin(route);
      expect(again.status, JSON.stringify(again.body)).toBeGreaterThanOrEqual(400);
      expect(again.body).toMatchObject({ code: c.stale ?? "changed_since_approval" });
      const replay = await h.approvedCall(s, name, input);
      expect(replay.out.isError).toBe(true);
      expect(replay.out.text).toContain(c.replay ?? "changed_since_approval");
    },
  );

  it("the audit chain verifies with the via-agent rows", async () => {
    expect((await verifyAuditChain(fx.db)).ok).toBe(true);
  });
});

describe("listing follows each tool's own permission", () => {
  it("a contributor lists only the installs; a team admin reads at level read, all at read_write", async () => {
    const w = await h.world("read");
    await fx.admin.query(
      `UPDATE team_members SET role = 'contributor' WHERE team_id = $1 AND user_id = $2`,
      [w.team, w.member.id],
    );
    const contributor = await h.sandboxFor(w.team, w.member);
    expect(await h.listNames(contributor)).toEqual(["team_skills_installs_list"]);
    const admin = await h.sandboxFor(w.team, w.admin);
    const reads = teamTools
      .filter((t) => t.readOnly)
      .map((t) => t.name)
      .sort();
    expect(await h.listNames(admin)).toEqual(reads);
    await h.setLevel(w.team, "read_write");
    expect(await h.listNames(admin)).toEqual(teamTools.map((t) => t.name).sort());
  });
});

describe("egress header names stay with egress managers (ac-3)", () => {
  it("a member's route read hides them, the member has no tool, the manager's tool shows names only", async () => {
    const w = await h.world();
    const domain = await enabledDomain(w, ["X-Vault-Token"]);
    const asMember = await h.routesAs(w.team, w.member);
    const read = await asMember({ method: "GET", path: "/team/egress" });
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain("X-Vault-Token");
    const m = await h.sandboxFor(w.team, w.member);
    expect(await h.listNames(m)).not.toContain("team_egress_list");
    expect((await h.call(m, "team_egress_list", {})).isError).toBe(true);

    const s = await h.sandboxFor(w.team, w.admin);
    const out = await h.call(s, "team_egress_list", {});
    const row = (out.structured?.domains as { domain: string; header_names: string[] }[]).find(
      (d) => d.domain === domain,
    );
    expect(row?.header_names).toEqual(["X-Vault-Token"]);
    expect(out.text).not.toContain("v2.test.sealed");
  });

  it("disabling a domain with injected headers is refused (their values would be lost)", async () => {
    const w = await h.world();
    const domain = await enabledDomain(w, ["X-Vault-Token"]);
    const s = await h.sandboxFor(w.team, w.admin);
    const input = { domain, from_enabled: true };
    const { out } = await h.approvedCall(s, "team_egress_disable", input);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("injected_headers");
    // The route refuses it too (the tool's own condition), under its delete.
    const admin = await h.routesAs(w.team, w.admin);
    const res = await admin(tool("team_egress_disable").route(input));
    expect(res).toMatchObject({ status: 409, body: { code: "injected_headers" } });
    const { rows } = await fx.admin.query(
      `SELECT header_names FROM team_egress WHERE team_id = $1 AND domain = $2`,
      [w.team, domain],
    );
    expect(rows).toHaveLength(1);
  });
});

describe("results are paged and capped (ac-4)", () => {
  it("pages 60 invitations as 50 and 10 with an opaque cursor", async () => {
    const w = await h.world();
    for (let i = 0; i < 60; i++) await invitation(w, `p${i}-${short()}@example.com`);
    const s = await h.sandboxFor(w.team, w.admin);
    const first = await h.call(s, "team_invites_list", {});
    const rows = first.structured?.invitations as unknown[];
    expect(rows).toHaveLength(50);
    const cursor = first.structured?.next_cursor as string;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const second = await h.call(s, "team_invites_list", { cursor });
    expect(second.structured?.invitations as unknown[]).toHaveLength(10);
    expect(second.structured?.next_cursor).toBeUndefined();
  });

  it("pages the audit log by seq, newest first, without IP or user agent", async () => {
    const w = await h.world();
    await fx.admin
      .query(`UPDATE audit_log SET ip = '10.1.2.3' WHERE team_id = $1`, [w.team])
      .catch(() => undefined);
    for (let i = 0; i < 3; i++) await invitation(w);
    // Real events: role changes through the console route.
    for (const role of ["contributor", "member", "contributor", "member"]) {
      const res = await w.admin.browser.patch(`/v1/team/members/${w.target.id}`, { role });
      expect(res.status).toBe(200);
    }
    const s = await h.sandboxFor(w.team, w.admin);
    const first = await h.call(s, "team_audit_list", { action: "identity.member.role_changed" });
    const events = first.structured?.events as { seq: number; action: string }[];
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => b - a));
    expect(first.text).not.toMatch(/"ip"|userAgent|prevHash/);
    // A short page has no cursor; a filter to everything pages on.
    expect(first.structured?.next_cursor).toBeUndefined();
  });
});

describe("route conditionals refuse a stale before-state (console paths unchanged)", () => {
  it("members, invites, connectors, budgets and memory answer 409 changed_since_approval", async () => {
    const w = await h.world();
    const b = w.admin.browser;
    const stale = async (res: Promise<{ status: number; json: unknown }>) => {
      const r = await res;
      expect(r.status, JSON.stringify(r.json)).toBe(409);
      expect(r.json).toMatchObject({ code: "changed_since_approval" });
    };
    await stale(b.delete(`/v1/team/members/${w.target.id}?expectedRole=contributor`));
    const inv = await invitation(w, `x-${short()}@example.com`);
    await stale(b.delete(`/v1/team/invites/${inv}?expectedRole=team_admin`));
    const conn = await enabledConnector(w);
    await stale(
      b.put(`/v1/team/connectors/${conn}`, { exposure: "read_only", expected_exposure: "off" }),
    );
    await stale(b.delete(`/v1/team/connectors/${conn}?expectedExposure=read_only`));
    await stale(
      b.put("/v1/team/budgets/team", {
        monthly_usd: 5,
        expected: { ...NONE, monthly_usd: 1, user_requests_per_minute: null },
      }),
    );
    await stale(
      b.put("/v1/memory/settings?level=team", {
        memory_enabled: false,
        expected: { memory_enabled: false, project_memory_enabled: true },
      }),
    );
    // The console's own calls (no condition) still work.
    expect((await b.put("/v1/memory/settings?level=team", { memory_enabled: false })).status).toBe(
      200,
    );
    expect((await b.delete(`/v1/team/invites/${inv}`)).status).toBe(204);
    expect(
      await fx.admin
        .query(`SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2`, [
          w.team,
          w.target.id,
        ])
        .then((r) => r.rowCount),
    ).toBe(1);
  });
});

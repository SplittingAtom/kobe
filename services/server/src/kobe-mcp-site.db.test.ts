import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  FakeUpstream,
  NO_GRANTS,
  createApp as createProxyApp,
  createLimiter,
  createPolicyServer,
  createUpstreamClient,
  type UpstreamClient,
} from "@kobe/mcp-proxy";
import {
  KOBE_BUILTIN_CONNECTOR_ID,
  KOBE_MCP_MODE_KEY,
  seedKobeBuiltinConnector,
  verifyAuditChain,
} from "@kobe/db";
import { approvalKeyring } from "./approvals/index.js";
import { runWithAuditContext } from "./audit/context.js";
import { recordAuditAfter } from "./audit/record.js";
import type { KobeTool } from "./kobe-mcp/catalog.js";
import { routeCaller } from "./kobe-mcp/execute.js";
import { KOBE_SITE_TOOLS } from "./kobe-mcp/tools/site/index.js";
import { createInternalApp } from "./routes/internal.js";
import { EventStreamFixture, type Person } from "./testing/event-stream-fixture.js";
import {
  INTERNAL_KEY,
  MCP_VERIFY_KEYS,
  allowApproval,
  leaseRun,
  mcpToken,
} from "./testing/mcp-fixtures.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * The Site console tools of the built-in Kobe MCP server end to end (KOBE-622, spec
 * kobe-admin-mcp §5 Site list, §6, §8; KA-5 ac-1..5): the real MCP proxy app talks HTTP to the real
 * internal listener, which decides and runs each console route in process as the person, on a real
 * Postgres.
 */
const fx = new EventStreamFixture();
const KEYRING = approvalKeyring("k".repeat(48));
const objects = new MemoryObjects();
const live = new Set<string>();
const upstreamServer = new FakeUpstream();
let internal: ServerType;
let upstream: UpstreamClient;
let proxy: ReturnType<typeof createProxyApp>;
let kobeName = "kobe";

beforeAll(async () => {
  await fx.setup([{}], () => ({
    sandboxWire: { sweep: false },
    approvalKeys: KEYRING,
    blobs: { objects, prefix: "kobe/" },
  }));
  const seeded = await seedKobeBuiltinConnector(fx.db);
  if (seeded.outcome === "names_taken") throw new Error("kobe names taken");
  kobeName = seeded.name;
  await upstreamServer.start();
  const app = createInternalApp({
    internalKey: INTERNAL_KEY,
    mcp: fx.replica(0).deps.mcp,
    kobe: fx.replica(0).deps.kobeMcp,
    auth: {
      db: fx.db,
      sessionVerifyKeys: MCP_VERIFY_KEYS,
      liveness: { isLive: ({ sandboxId }) => Promise.resolve(live.has(sandboxId)) },
    },
  });
  internal = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const { port } = internal.address() as AddressInfo;
  upstream = createUpstreamClient({
    policy: {
      allowInsecureHttp: true,
      allowedPorts: [],
      allowedInternalCidrs: [],
      deniedCidrs: [],
    },
    maxResponseBytes: 1024 * 1024,
  });
  proxy = createProxyApp({
    sessionVerifyKeys: MCP_VERIFY_KEYS,
    server: createPolicyServer({
      baseUrl: `http://127.0.0.1:${port}`,
      internalKey: INTERNAL_KEY,
      timeoutMs: 10_000,
    }),
    upstream,
    credentials: NO_GRANTS,
    limiter: createLimiter({
      burst: 1_000,
      perSecond: 100,
      callsPerSandbox: 8,
      maxConcurrentCalls: 64,
    }),
    limits: { ...DEFAULT_LIMITS, upstreamTimeoutMs: 10_000 },
    log: pino({ level: "silent" }),
  });
});

afterAll(async () => {
  await upstream.close();
  await upstreamServer.stop();
  await new Promise<void>((resolve) => internal.close(() => resolve()));
  await fx.teardown();
});

const setSite = async (key: string, value: string | null) => {
  if (value === null) await fx.admin.query(`DELETE FROM site_settings WHERE key = $1`, [key]);
  else
    await fx.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, value],
    );
};
const setLevel = (team: string, level: string) =>
  fx.admin.query(
    `UPDATE teams SET settings = settings || jsonb_build_object('kobe_mcp.admin', $2::text) WHERE id = $1`,
    [team, level],
  );

beforeEach(async () => {
  await setSite(KOBE_MCP_MODE_KEY, "admin");
  await setSite("kobe_mcp.reads_per_minute", "10000");
  await setSite("kobe_mcp.writes_per_hour", "10000");
});

interface World {
  readonly team: string;
  /** Site admin and the team's first team admin. */
  readonly siteAdmin: Person;
  /** Team admin without a site role. */
  readonly teamAdmin: Person;
  /** Member holding the Skill reviewer grant. */
  readonly reviewer: Person;
  readonly member: Person;
  readonly target: Person;
}

const short = () => randomUUID().slice(0, 4);

async function world(): Promise<World> {
  const siteAdmin = await fx.person(`sa${short()}`);
  const teamAdmin = await fx.person(`ta${short()}`);
  const reviewer = await fx.person(`rv${short()}`);
  const member = await fx.person(`mb${short()}`);
  const target = await fx.person(`tg${short()}`);
  const team = await fx.team(`site-${randomUUID().slice(0, 6)}`, siteAdmin, [
    teamAdmin,
    reviewer,
    member,
    target,
  ]);
  await fx.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [
    siteAdmin.id,
  ]);
  await fx.admin.query(
    `UPDATE team_members SET role = 'team_admin' WHERE team_id = $1 AND user_id = $2`,
    [team, teamAdmin.id],
  );
  await fx.admin.query(
    `INSERT INTO site_grants (user_id, "grant", granted_by) VALUES ($1, 'skill_reviewer', $2)`,
    [reviewer.id, siteAdmin.id],
  );
  await setLevel(team, "read_write");
  return { team, siteAdmin, teamAdmin, reviewer, member, target };
}

interface Sandbox {
  readonly team: string;
  readonly person: Person;
  readonly token: string;
  readonly runId: string;
  readonly threadId: string;
}

async function sandboxFor(team: string, person: Person): Promise<Sandbox> {
  const sandboxId = randomUUID();
  live.add(sandboxId);
  const runId = await fx.run(team, person);
  const threadId = await leaseRun(fx.admin, team, runId, person.id, sandboxId);
  return {
    team,
    person,
    token: mcpToken({ sandboxId, teamId: team, userId: person.id }),
    runId,
    threadId,
  };
}

let nextId = 1;
async function rpc(s: Sandbox, method: string, params?: Record<string, unknown>) {
  const res = await proxy.request(`/v1/mcp/${KOBE_BUILTIN_CONNECTOR_ID}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${s.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "kobe-thread-id": s.threadId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : undefined };
}

const siteNames = async (s: Sandbox): Promise<string[]> => {
  const res = await rpc(s, "tools/list");
  if (res.status !== 200) return [`status:${res.status}`];
  return (res.json?.result.tools as { name: string }[])
    .map((t) => t.name)
    .filter((n) => n.startsWith("site_"))
    .sort();
};

async function call(s: Sandbox, name: string, args: Record<string, unknown>, toolCallId?: string) {
  const res = await rpc(s, "tools/call", {
    name,
    arguments: args,
    ...(toolCallId ? { _meta: { "kobe.dev/tool_call_id": toolCallId } } : {}),
  });
  expect(res.status).toBe(200);
  const result = res.json?.result as {
    isError?: boolean;
    content: { text: string }[];
    structuredContent?: Record<string, unknown>;
  };
  return {
    ...(result.isError ? { isError: true } : {}),
    text: result.content[0]?.text ?? "",
    ...(result.structuredContent ? { structured: result.structuredContent } : {}),
  };
}

const pi = (tool: string) => `mcp__${kobeName.replace(/-/g, "_")}__${tool}`;
const approve = (s: Sandbox, tool: string, input: Record<string, unknown>) =>
  allowApproval(fx.admin, {
    teamId: s.team,
    runId: s.runId,
    threadId: s.threadId,
    userId: s.person.id,
    tool: pi(tool),
    input: input as never,
    key: KEYRING.current,
  });

const deactivated = async (userId: string) =>
  (
    await fx.admin.query<{ d: boolean }>(
      `SELECT deactivated_at IS NOT NULL AS d FROM users WHERE id = $1`,
      [userId],
    )
  ).rows[0]?.d;

const ALL_SITE = KOBE_SITE_TOOLS.map((t) => t.name).sort();
const REVIEWER_TOOLS = [
  "site_skill_reviews_claim",
  "site_skill_reviews_comment",
  "site_skill_reviews_decide",
  "site_skill_reviews_list",
];

/** A maintainer submission in the Registry, submitted by `by` (written directly). */
async function submittedVersion(by: Person): Promise<string> {
  const skill = await fx.admin.query<{ id: string }>(
    `INSERT INTO registry_skills (name, summary) VALUES ($1, 'Adds totals.') RETURNING id`,
    [`totals-${randomUUID().slice(0, 8)}`],
  );
  const hex = () => randomBytes(32).toString("hex");
  const version = await fx.admin.query<{ id: string }>(
    `INSERT INTO registry_versions
       (skill_id, semver, seq, runtime_hash, package_hash, manifest, provenance, source, scan,
        verdict, submitted_by)
     VALUES ($1, '1.0.0', 1, $2, $3, '{}', '{}', '{}', '{}', 'pass', $4) RETURNING id`,
    [skill.rows[0]?.id, hex(), hex(), by.id],
  );
  return version.rows[0]?.id ?? "";
}

describe("who lists and calls the site tools (ac-1, ac-2, ac-4)", () => {
  it("a team admin without a site role lists no site tool; a forged call is refused", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.teamAdmin);
    expect(await siteNames(s)).toEqual([]);
    const input = { user_id: w.target.id, from_state: "active" };
    expect((await call(s, "site_users_deactivate", input)).isError).toBe(true);
    // Even with the person's own approval in hand.
    await approve(s, "site_users_deactivate", input);
    const forged = await call(s, "site_users_deactivate", input);
    expect(forged.isError).toBe(true);
    expect(forged.text).toContain("not available to you");
    expect(await deactivated(w.target.id)).toBe(false);
    expect((await call(s, "site_users_list", {})).isError).toBe(true);
  });

  it("a Skill reviewer lists only the reviewer actions; reject and block is refused", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.reviewer);
    expect(await siteNames(s)).toEqual(REVIEWER_TOOLS);
    const id = await submittedVersion(w.target);
    const input = { version_id: id, from_state: "submitted", note: "Exfiltrates data." };
    await approve(s, "site_skill_reviews_reject_and_block", input);
    const out = await call(s, "site_skill_reviews_reject_and_block", input);
    expect(out.isError).toBe(true);
    expect((await call(s, "site_skill_blocklist_list", {})).isError).toBe(true);
    const listed = await call(s, "site_skill_reviews_list", {});
    expect(listed.isError).toBeUndefined();
    expect(
      (listed.structured?.items as { version_id: string }[]).map((i) => i.version_id),
    ).toContain(id);
  });

  it("a site admin lists every site tool; the site and team switches hide them", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.siteAdmin);
    expect(await siteNames(s)).toEqual(ALL_SITE);
    await setLevel(w.team, "read");
    expect(await siteNames(s)).toEqual(
      KOBE_SITE_TOOLS.filter((t) => t.readOnly)
        .map((t) => t.name)
        .sort(),
    );
    await setLevel(w.team, "docs");
    expect(await siteNames(s)).toEqual([]);
    await setLevel(w.team, "read_write");
    await setSite(KOBE_MCP_MODE_KEY, "docs");
    expect(await siteNames(s)).toEqual([]);
    expect((await call(s, "site_users_list", {})).isError).toBe(true);
  });
});

describe("audit reads (ac-3)", () => {
  it("never include the IP address or user agent", async () => {
    const w = await world();
    await runWithAuditContext(
      { actor: { kind: "user", id: w.siteAdmin.id }, ip: "203.0.113.9", userAgent: "UA-Test/9.9" },
      () =>
        recordAuditAfter(fx.db, {
          action: "identity.team.renamed",
          teamId: w.team,
          target: { name: "Renamed" },
        }),
    );
    const { rows } = await fx.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE user_agent = 'UA-Test/9.9'`,
    );
    expect(rows[0]?.n).toBe(1);
    const s = await sandboxFor(w.team, w.siteAdmin);
    const out = await call(s, "site_audit_list", { team_id: w.team });
    expect(out.isError).toBeUndefined();
    expect(out.text).toContain("identity.team.renamed");
    expect(out.text).not.toContain("203.0.113.9");
    expect(out.text).not.toContain("UA-Test");
    expect(out.text).not.toMatch(/"(ip|userAgent)"/);
  });
});

describe("writes run exactly what was approved", () => {
  it("deactivates with an approval, audited as the person via agent", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.siteAdmin);
    const input = { user_id: w.target.id, from_state: "active" };
    const approval = await approve(s, "site_users_deactivate", input);
    const out = await call(s, "site_users_deactivate", input, approval.toolCallId);
    expect(out.isError, out.text).toBeUndefined();
    expect(out.structured).toMatchObject({ user_id: w.target.id, deactivated: true });
    expect(await deactivated(w.target.id)).toBe(true);
    const { rows } = await fx.admin.query<{ actor_id: string; target: Record<string, unknown> }>(
      `SELECT actor_id, target FROM audit_log WHERE action = 'identity.user.deactivated'
        AND target->>'userId' = $1`,
      [w.target.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: w.siteAdmin.id,
      target: {
        viaAgent: { runId: s.runId, threadId: s.threadId, toolCallId: approval.toolCallId },
      },
    });
    expect((await verifyAuditChain(fx.db)).ok).toBe(true);
  });

  it("refuses changed_since_approval when the before-state moved", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.siteAdmin);
    await fx.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [w.target.id]);
    const input = { user_id: w.target.id, from_state: "active" };
    await approve(s, "site_users_deactivate", input);
    const out = await call(s, "site_users_deactivate", input);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("changed_since_approval");
  });
});

describe("the routes' own before-state conditions (409 changed_since_approval)", () => {
  it("users, connectors, egress ceiling, models, budget and branding", async () => {
    const w = await world();
    const b = w.siteAdmin.browser;
    const conflict = (r: { status: number; json: unknown }) => {
      expect(r.status, JSON.stringify(r.json)).toBe(409);
      expect(r.json).toMatchObject({ code: "changed_since_approval" });
    };
    conflict(
      await b.post(`/v1/site/users/${w.target.id}/reactivate`, { expectedState: "deactivated" }),
    );
    const connector = await insertConnector();
    conflict(
      await b.patch(`/v1/site/connectors/${connector}`, {
        status: "active",
        expectedStatus: "disabled",
      }),
    );
    expect((await b.post("/v1/site/egress-ceiling", { domain: "kobe-622.example" })).status).toBe(
      201,
    );
    conflict(
      await b.put("/v1/site/egress-ceiling/kobe-622.example", {
        in_ceiling: false,
        expected_in_ceiling: false,
      }),
    );
    const alias = await catalogModel(w.siteAdmin);
    conflict(
      await b.patch(`/v1/site/models/catalog/${alias}`, { label: "X", expected: { label: "Y" } }),
    );
    conflict(await b.put("/v1/site/budget", { daily_usd: 5, expected: { daily_usd: 1 } }));
    conflict(
      await b.put("/v1/site/branding", { showName: false, expected: { appName: "Not it" } }),
    );
    // Unchanged without a before-state: the console's own calls still work.
    expect((await b.put("/v1/site/budget", { daily_usd: 5 })).status).toBe(200);
  });
});

async function insertConnector(): Promise<string> {
  const { rows } = await fx.admin.query<{ id: string }>(
    `INSERT INTO connectors (name, url) VALUES ($1, 'https://mcp.example.com/mcp') RETURNING id`,
    [`c${randomUUID().slice(0, 8)}`],
  );
  return rows[0]?.id ?? "";
}

let providerReady = false;
async function catalogModel(admin: Person): Promise<string> {
  if (!providerReady) {
    // Written directly: adding a provider through the console needs the model gateway.
    await fx.admin.query(
      `INSERT INTO model_providers (id, kind, name, base_url, created_by)
       VALUES ('ollama', 'ollama', 'Ollama', 'http://ollama.example:11434', $1)
       ON CONFLICT (id) DO NOTHING`,
      [admin.id],
    );
    providerReady = true;
  }
  const alias = `m${randomUUID().slice(0, 6)}`;
  const r = await admin.browser.post("/v1/site/models/catalog", {
    alias,
    provider_id: "ollama",
    model: "llama3",
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return alias;
}

/**
 * Contract (spec §5, KA-5 ac-5): every site tool's route, called as a person without the tool's
 * permission (a team admin without a site role), is refused 403, and as a site admin it answers
 * with something the tool's output schema accepts; each write's audit events are the console's own,
 * recorded as the person via agent.
 */
describe("site catalog contract (ac-5)", () => {
  type Ctx = { readonly w: World };
  const samples: Readonly<Record<string, (ctx: Ctx) => Promise<Record<string, unknown>>>> = {
    site_users_list: async () => ({}),
    site_memory_items_list: async () => ({}),
    site_memory_item_get: async ({ w }) => {
      const r = await w.siteAdmin.browser.post("/v1/memory/semantic/items", {
        scope: "site",
        kind: "fact",
        statement: `Site fact ${short()}`,
      });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      return { id: (r.json as { id: string }).id };
    },
    site_users_deactivate: async ({ w }) => ({ user_id: w.target.id, from_state: "active" }),
    site_users_reactivate: async ({ w }) => {
      await fx.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [w.target.id]);
      return { user_id: w.target.id, from_state: "deactivated" };
    },
    site_teams_list: async () => ({ query: "site-" }),
    site_teams_create: async ({ w }) => ({
      slug: `n-${randomUUID().slice(0, 8)}`,
      name: "New team",
      admin_user_id: w.member.id,
    }),
    site_team_members_list: async ({ w }) => ({ team_id: w.team }),
    site_team_members_add: async ({ w }) => {
      // Another team (the Site admin is a member of the world's own team).
      const r = await w.siteAdmin.browser.post("/v1/site/teams", {
        slug: `add-${short()}`,
        name: "Add target",
        adminUserId: w.teamAdmin.id,
      });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      const teamId = (r.json as { team: { id: string } }).team.id;
      return { team_id: teamId, user_ids: [w.member.id], role: "member" };
    },
    site_team_members_set_role: async ({ w }) => ({
      team_id: w.team,
      user_id: w.target.id,
      from_role: "member",
      to_role: "contributor",
    }),
    site_team_members_remove: async ({ w }) => ({
      team_id: w.team,
      user_id: w.target.id,
      from_role: "member",
    }),
    site_invites_list: async () => ({}),
    site_invites_create: async () => ({ email: `new-${short()}@invite.test` }),
    site_invites_revoke: async ({ w }) => {
      const email = `rv-${short()}@invite.test`;
      const r = await w.siteAdmin.browser.post("/v1/site/invites", { email });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      return { invitation_id: (r.json as { invitation: { id: string } }).invitation.id, email };
    },
    site_models_list: async () => ({}),
    site_models_catalog_update: async ({ w }) => ({
      alias: await catalogModel(w.siteAdmin),
      change: { from: { label: null }, to: { label: "Fast" } },
    }),
    site_connectors_list: async () => ({}),
    site_connectors_set_status: async () => ({
      connector_id: await insertConnector(),
      from_status: "active",
      to_status: "disabled",
    }),
    site_egress_ceiling_list: async () => ({}),
    site_egress_ceiling_add: async () => ({ domain: `a${short()}.example.org` }),
    site_egress_ceiling_set: async ({ w }) => {
      const domain = `s${short()}.example.org`;
      expect((await w.siteAdmin.browser.post("/v1/site/egress-ceiling", { domain })).status).toBe(
        201,
      );
      return { domain, from_in_ceiling: true, to_in_ceiling: false };
    },
    site_egress_requests_list: async () => ({ status: "all" }),
    site_egress_requests_decide: async ({ w }) => {
      const domain = `r${short()}.example.net`;
      const { rows } = await fx.admin.query<{ id: string }>(
        `INSERT INTO egress_requests (team_id, domain, pattern, requested_by, scope)
         VALUES ($1, $2, $2, $3, 'site') RETURNING id`,
        [w.team, domain, w.member.id],
      );
      return {
        team_id: w.team,
        request_id: rows[0]?.id,
        from_status: "pending",
        decision: "deny",
      };
    },
    site_skill_reviews_list: async () => ({ state: "all" }),
    site_skill_reviews_claim: async ({ w }) => ({
      version_id: await submittedVersion(w.target),
      from_state: "submitted",
    }),
    site_skill_reviews_comment: async ({ w }) => ({
      version_id: await submittedVersion(w.target),
      note: "Please add a test.",
    }),
    site_skill_reviews_decide: async ({ w }) => ({
      version_id: await submittedVersion(w.target),
      from_state: "submitted",
      action: "request_changes",
      note: "Add a test.",
    }),
    site_skill_reviews_reject_and_block: async ({ w }) => ({
      version_id: await submittedVersion(w.target),
      from_state: "submitted",
      note: "Exfiltrates data.",
    }),
    site_skill_blocklist_list: async () => ({}),
    site_skill_blocklist_add: async () => ({
      content_hash: randomBytes(32).toString("hex"),
      reason: "malware",
    }),
    site_skill_blocklist_remove: async ({ w }) => {
      const hash = randomBytes(32).toString("hex");
      const r = await w.siteAdmin.browser.post("/v1/site/skill-blocklist", {
        contentHash: hash,
        reason: "test",
      });
      expect(r.status).toBe(201);
      return { content_hash: hash };
    },
    site_grants_list: async () => ({}),
    site_grants_give: async ({ w }) => ({ user_id: w.member.id, grant: "skill_reviewer" }),
    site_grants_take: async ({ w }) => ({ user_id: w.reviewer.id, grant: "skill_reviewer" }),
    site_branding_get: async () => ({}),
    site_branding_set: async () => ({
      change: { from: { app_name: "Kobe" }, to: { app_name: "Kobe Lab" } },
    }),
    site_budget_get: async () => ({}),
    site_budget_set: async () => {
      const { rows } = await fx.admin.query<{ v: number | null }>(
        `SELECT user_requests_per_minute AS v FROM site_model_limits WHERE id = 1`,
      );
      return {
        change: {
          from: { user_requests_per_minute: rows[0]?.v ?? 60 },
          to: { user_requests_per_minute: 61 },
        },
      };
    },
    site_usage_read: async () => ({}),
    site_audit_list: async () => ({ limit: 5 }),
  };
  /** Read routes that are public or looser than the page (refused by the Kobe layer instead). */
  const LOOSER_ROUTE = new Set(["site_branding_get"]);

  it("names a sample for every site tool", () => {
    expect(KOBE_SITE_TOOLS.map((t) => t.name).filter((n) => !(n in samples))).toEqual([]);
  });

  it.each(KOBE_SITE_TOOLS.map((t) => [t.name, t] as const))(
    "%s: refused without the permission, answered with it",
    async (name, tool: KobeTool) => {
      const w = await world();
      const as = async (p: Person) => {
        const s = await sandboxFor(w.team, p);
        return {
          s,
          call: routeCaller(fx.replica(0).app, {
            userId: p.id,
            teamId: w.team,
            runId: s.runId,
            threadId: s.threadId,
            toolCallId: `contract-${name}`,
          }),
        };
      };
      const input = tool.input.parse(await samples[name]?.({ w }));
      const route = tool.route(input);
      if (LOOSER_ROUTE.has(name)) {
        expect(await siteNames(await sandboxFor(w.team, w.teamAdmin))).not.toContain(name);
      } else {
        const refused = await (await as(w.teamAdmin)).call(route);
        expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      }
      const { rows: mark } = await fx.admin.query<{ seq: string }>(
        `SELECT coalesce(max(seq), 0)::text AS seq FROM audit_log`,
      );
      const holder = await as(w.siteAdmin);
      const held = await holder.call(route);
      expect(held.status, JSON.stringify(held.body)).toBeLessThan(300);
      expect(() => tool.output.parse(tool.reduce(held.body, input))).not.toThrow();
      if (!tool.readOnly) {
        const { rows } = await fx.admin.query<{
          action: string;
          actor_kind: string;
          actor_id: string;
          target: { viaAgent?: { runId?: string } };
        }>(
          `SELECT action, actor_kind, actor_id, target FROM audit_log
            WHERE seq > $1 AND actor_id = $2 AND action <> 'mcp.tool_call' ORDER BY seq`,
          [mark[0]?.seq, w.siteAdmin.id],
        );
        expect(rows.length, `${name} recorded no console event`).toBeGreaterThan(0);
        for (const r of rows) {
          expect(r.actor_kind).toBe("user");
          expect(r.target.viaAgent?.runId, r.action).toBe(holder.s.runId);
        }
      }
    },
  );

  it("a Skill reviewer's route permissions: reviewer actions yes, block no", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.reviewer);
    const call = routeCaller(fx.replica(0).app, {
      userId: w.reviewer.id,
      teamId: w.team,
      runId: s.runId,
      threadId: s.threadId,
      toolCallId: "reviewer",
    });
    const id = await submittedVersion(w.target);
    const routeOf = (name: string, input: Record<string, unknown>) => {
      const t = KOBE_SITE_TOOLS.find((x) => x.name === name);
      if (t === undefined) throw new Error(name);
      return t.route(t.input.parse(input));
    };
    const blocked = await call(
      routeOf("site_skill_reviews_reject_and_block", {
        version_id: id,
        from_state: "submitted",
        note: "x",
      }),
    );
    expect(blocked.status).toBe(403);
    const rejected = await call(
      routeOf("site_skill_reviews_decide", {
        version_id: id,
        from_state: "submitted",
        action: "reject",
      }),
    );
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
  });
});

describe("before-states checked by the routes themselves (review LOW, KOBE-623)", () => {
  const routeOf = (name: string, input: Record<string, unknown>) => {
    const tool = KOBE_SITE_TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(name);
    return tool.route(input as never);
  };

  it("the tools send the state they were approved against", () => {
    const v = "00000000-0000-4000-8000-000000000001";
    expect(
      routeOf("site_skill_reviews_claim", { version_id: v, from_state: "submitted" }).query,
    ).toEqual({ expectedState: "submitted" });
    expect(
      routeOf("site_skill_reviews_decide", {
        version_id: v,
        from_state: "in_review",
        action: "reject",
      }).body,
    ).toMatchObject({ expected_state: "in_review" });
    expect(
      routeOf("site_skill_reviews_reject_and_block", {
        version_id: v,
        from_state: "submitted",
        note: "x",
      }).body,
    ).toMatchObject({ expected_state: "submitted" });
    expect(routeOf("site_invites_revoke", { invitation_id: v, email: "a@b.test" }).query).toEqual({
      expectedEmail: "a@b.test",
    });
  });

  it("claim and decide refuse a version no longer in the approved state, under its lock", async () => {
    const w = await world();
    const version = await submittedVersion(w.target);
    const base = `/v1/site/skills/registry/${version}`;
    const stale = await w.siteAdmin.browser.post(`${base}/claim?expectedState=in_review`, {});
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("changed_since_approval");
    for (const action of ["reject", "reject_and_block"]) {
      const d = await w.siteAdmin.browser.post(`${base}/decision`, {
        action,
        note: "No.",
        expected_state: "in_review",
      });
      expect(d.status, action).toBe(409);
      expect(d.json.code).toBe("changed_since_approval");
    }
    const approveStale = await w.siteAdmin.browser.post(`${base}/decision`, {
      action: "approve",
      expected_state: "in_review",
    });
    expect(approveStale.json.code).toBe("changed_since_approval");
    const { rows } = await fx.admin.query<{ state: string }>(
      `SELECT state FROM registry_versions WHERE id = $1`,
      [version],
    );
    expect(rows[0]?.state).toBe("submitted");
    const ok = await w.siteAdmin.browser.post(`${base}/claim?expectedState=submitted`, {});
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.state).toBe("in_review");
  });

  it("revoking a site invitation checks the approved address in the same statement", async () => {
    const w = await world();
    const email = `rv-${short()}@invite.test`;
    const r = await w.siteAdmin.browser.post("/v1/site/invites", { email });
    const id = (r.json as { invitation: { id: string } }).invitation.id;
    const stale = await w.siteAdmin.browser.request(
      "DELETE",
      `/v1/site/invites/${id}?expectedEmail=${encodeURIComponent("other@invite.test")}`,
    );
    expect(stale.status).toBe(409);
    const ok = await w.siteAdmin.browser.request(
      "DELETE",
      `/v1/site/invites/${id}?expectedEmail=${encodeURIComponent(email.toUpperCase())}`,
    );
    expect(ok.status).toBe(204);
  });
});

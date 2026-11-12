import { randomUUID } from "node:crypto";
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
import { KOBE_BUILTIN_CONNECTOR_ID as PROTOCOL_KOBE_ID } from "@kobe/protocol";
import { llmsTxt, PAGES } from "@kobe/guide";
import { withTeam } from "@kobe/db";
import { approvalKeyring } from "./approvals/index.js";
import { delegationBacked } from "./kobe-mcp/delegation-live.js";
import { kobeRunServer } from "./kobe-mcp/run.js";
import { KOBE_ADMIN_TOOLS } from "./kobe-mcp/tools/index.js";
import { createInternalApp } from "./routes/internal.js";
import { TestBrowser } from "./testing/browser.js";
import { EventStreamFixture, PUBLIC_URL, type Person } from "./testing/event-stream-fixture.js";
import {
  INTERNAL_KEY,
  MCP_VERIFY_KEYS,
  allowApproval,
  leaseRun,
  mcpToken,
} from "./testing/mcp-fixtures.js";

/**
 * The built-in Kobe MCP server end to end (KOBE-619, spec kobe-admin-mcp §3, §6–§8, KA-2 ac-1..6):
 * a sandbox calls the **real MCP proxy app**, which talks HTTP to the **real internal listener**;
 * the server decides (policy engine, Kobe admin guard, signed approvals over the `approvals` table,
 * audit) and executes the console route in process as the person, on a real Postgres. The sandbox
 * here is "tampered": it never sends `policy.check`, so only the proxy-side re-check stands.
 */
const fx = new EventStreamFixture();
const KEYRING = approvalKeyring("k".repeat(48));
const live = new Set<string>();
const upstreamServer = new FakeUpstream();
let internal: ServerType;
let upstream: UpstreamClient;
let proxy: ReturnType<typeof createProxyApp>;
let kobeName = "kobe";

beforeAll(async () => {
  await fx.setup([{}], () => ({ sandboxWire: { sweep: false }, approvalKeys: KEYRING }));
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
const setLevel = (team: string, level: string | null) =>
  fx.admin.query(
    level === null
      ? `UPDATE teams SET settings = settings - 'kobe_mcp.admin' WHERE id = $1`
      : `UPDATE teams SET settings = settings || jsonb_build_object('kobe_mcp.admin', $2::text) WHERE id = $1`,
    level === null ? [team] : [team, level],
  );

beforeEach(async () => {
  await setSite(KOBE_MCP_MODE_KEY, "admin");
  await setSite("kobe_mcp.reads_per_minute", null);
  await setSite("kobe_mcp.writes_per_hour", null);
});

interface Sandbox {
  readonly team: string;
  readonly person: Person;
  readonly sandboxId: string;
  readonly token: string;
  readonly runId: string;
  readonly threadId: string;
}

interface World {
  readonly team: string;
  readonly admin: Person;
  readonly member: Person;
  readonly target: Person;
}

async function world(level: string | null = "read_write"): Promise<World> {
  const admin = await fx.person(`ka${randomUUID().slice(0, 4)}`);
  const member = await fx.person(`km${randomUUID().slice(0, 4)}`);
  const target = await fx.person(`kt${randomUUID().slice(0, 4)}`);
  const team = await fx.team(`kobe-${randomUUID().slice(0, 6)}`, admin, [member, target]);
  await setLevel(team, level);
  return { team, admin, member, target };
}

async function sandboxFor(team: string, person: Person): Promise<Sandbox> {
  const sandboxId = randomUUID();
  live.add(sandboxId);
  const runId = await fx.run(team, person);
  const threadId = await leaseRun(fx.admin, team, runId, person.id, sandboxId);
  return {
    team,
    person,
    sandboxId,
    token: mcpToken({ sandboxId, teamId: team, userId: person.id }),
    runId,
    threadId,
  };
}

let nextId = 1;
async function rpc(
  s: Sandbox,
  method: string,
  params?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const res = await proxy.request(`/v1/mcp/${KOBE_BUILTIN_CONNECTOR_ID}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${s.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "kobe-thread-id": s.threadId,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : undefined };
}

const listNames = async (s: Sandbox): Promise<string[]> => {
  const res = await rpc(s, "tools/list");
  if (res.status !== 200) return [`status:${res.status}`];
  return (res.json?.result.tools as { name: string }[]).map((t) => t.name).sort();
};

async function call(
  s: Sandbox,
  name: string,
  args: Record<string, unknown>,
  toolCallId?: string,
): Promise<{ isError?: boolean; text: string; structured?: Record<string, unknown> }> {
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

const roleOf = async (team: string, userId: string) => {
  const { rows } = await fx.admin.query<{ role: string }>(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [team, userId],
  );
  return rows[0]?.role;
};

/** KOBE-620 (KA7): the docs tools are listed on every run while the site switch is not off. */
const DOCS = ["docs_full", "docs_index", "docs_page", "docs_search"];
const withDocs = (...names: string[]) => [...DOCS, ...names].sort();

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

const decisions = async (team: string) => {
  const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'mcp.tool_call' ORDER BY seq`,
    [team],
  );
  return rows.map((r) => r.target);
};

describe("the built-in connector's identity", () => {
  it("has the same fixed id in @kobe/db and @kobe/protocol (the proxy routes by it)", () => {
    expect(PROTOCOL_KOBE_ID).toBe(KOBE_BUILTIN_CONNECTOR_ID);
  });
});

describe("listing follows the person's permission and both switches (ac-1, KA5)", () => {
  it("a member's sandbox lists no team-admin tool; a forged call is refused like a 403", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.member);
    expect(await listNames(s)).toEqual(withDocs());
    const forged = await call(s, "team_members_set_role", {
      user_id: w.target.id,
      from_role: "member",
      to_role: "team_admin",
    });
    expect(forged.isError).toBe(true);
    expect(forged.text).toContain("Kobe denied this call");
    expect(forged.text).toContain("not available to you");
    expect(await roleOf(w.team, w.target.id)).toBe("member");
    expect((await decisions(w.team)).at(-1)).toMatchObject({
      decision: "denied",
      reason: "kobe_admin_not_allowed",
      connectorId: KOBE_BUILTIN_CONNECTOR_ID,
    });
    // Even with an approval in hand (the member approved their own forged call).
    await approve(s, "team_members_set_role", {
      user_id: w.target.id,
      from_role: "member",
      to_role: "team_admin",
    });
    const approved = await call(s, "team_members_set_role", {
      user_id: w.target.id,
      from_role: "member",
      to_role: "team_admin",
    });
    expect(approved.isError).toBe(true);
    expect(await roleOf(w.team, w.target.id)).toBe("member");
  });

  it("a team admin lists by the team level: docs none, read the reads, read_write all", async () => {
    const w = await world(null);
    const s = await sandboxFor(w.team, w.admin);
    expect(await listNames(s)).toEqual(withDocs()); // default: docs only (KA5)
    const team = KOBE_ADMIN_TOOLS.filter((t) => t.scope === "team");
    await setLevel(w.team, "read");
    expect(await listNames(s)).toEqual(
      withDocs(...team.filter((t) => t.readOnly).map((t) => t.name)),
    );
    await setLevel(w.team, "read_write");
    expect(await listNames(s)).toEqual(withDocs(...team.map((t) => t.name)));
    // The site switch: docs hides every admin tool, off removes the connector.
    await setSite(KOBE_MCP_MODE_KEY, "docs");
    expect(await listNames(s)).toEqual(withDocs());
    await setSite(KOBE_MCP_MODE_KEY, null);
    expect(await listNames(s)).toEqual(withDocs());
    await setSite(KOBE_MCP_MODE_KEY, "off");
    expect((await rpc(s, "tools/list")).status).toBe(403);
    const off = await rpc(s, "tools/call", { name: "team_members_list", arguments: {} });
    expect(off.status).toBe(403);
  });

  it("a level that does not include a tool refuses its call too", async () => {
    const w = await world("read");
    const s = await sandboxFor(w.team, w.admin);
    const input = { user_id: w.target.id, from_role: "member", to_role: "contributor" };
    await approve(s, "team_members_set_role", input);
    const out = await call(s, "team_members_set_role", input);
    expect(out.isError).toBe(true);
    expect(await roleOf(w.team, w.target.id)).toBe("member");
  });
});

describe("reads run freely, as the person", () => {
  it("lists the team's members, reduced to the output schema and paged", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    const out = await call(s, "team_members_list", {});
    expect(out.isError).toBeUndefined();
    const members = (out.structured?.members ?? []) as { user_id: string; role: string }[];
    expect(members.map((m) => m.user_id).sort()).toEqual(
      [w.admin.id, w.member.id, w.target.id].sort(),
    );
    expect(Object.keys(members[0] ?? {}).sort()).toEqual(["email", "name", "role", "user_id"]);
    expect(out.structured?.next_cursor).toBeUndefined();
  });

  it("refuses a read in a scheduled run (docs tools only there)", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    await fx.admin.query(`UPDATE runs SET trigger = 'schedule' WHERE id = $1`, [s.runId]);
    const out = await call(s, "team_members_list", {});
    expect(out.isError).toBe(true);
    expect((await decisions(w.team)).at(-1)).toMatchObject({ reason: "kobe_admin_not_allowed" });
  });
});

describe("the docs tools (KOBE-620, KA-3; spec §4, KA4, KA7)", () => {
  const index = () => llmsTxt(PAGES, { appName: "Kobe", origin: new URL(PUBLIC_URL).origin });

  it("docs_index equals /llms.txt for the deployment's origin and app name (ac-1)", async () => {
    const w = await world(null);
    const s = await sandboxFor(w.team, w.member);
    const out = await call(s, "docs_index", {});
    expect(out.isError).toBeUndefined();
    expect(out.text).toBe(index());
    expect((await decisions(w.team)).at(-1)).toMatchObject({
      decision: "allowed",
      tool: pi("docs_index"),
      risk: "read",
    });
  });

  it("follows the site's app name", async () => {
    const w = await world(null);
    const s = await sandboxFor(w.team, w.member);
    await setSite("branding.app_name", "Acme Chat");
    try {
      const out = await call(s, "docs_index", {});
      expect(out.text.startsWith("# Acme Chat\n")).toBe(true);
    } finally {
      await setSite("branding.app_name", null);
    }
  });

  it("docs_page returns a page; an unknown or traversing slug is a tool error (ac-2)", async () => {
    const w = await world(null);
    const s = await sandboxFor(w.team, w.member);
    const page = PAGES[0] as (typeof PAGES)[number];
    const out = await call(s, "docs_page", { slug: page.slug });
    expect(out.text.startsWith(`# ${page.title}\n`)).toBe(true);
    for (const slug of ["no-such-page", "../../../etc/passwd"]) {
      const bad = await call(s, "docs_page", { slug });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("unknown_page");
    }
    const search = await call(s, "docs_search", { query: "approvals" });
    expect((search.structured?.results as unknown[]).length).toBeGreaterThan(0);
  });

  it("work in auto and scheduled runs and skill evals, with the site at docs and the team at docs only", async () => {
    await setSite(KOBE_MCP_MODE_KEY, "docs");
    const w = await world(null);
    const s = await sandboxFor(w.team, w.member);
    await fx.admin.query(`UPDATE runs SET approval_mode = 'auto' WHERE id = $1`, [s.runId]);
    expect((await call(s, "docs_index", {})).text).toBe(index());
    await fx.admin.query(`UPDATE runs SET trigger = 'schedule' WHERE id = $1`, [s.runId]);
    expect(await listNames(s)).toEqual(withDocs());
    expect((await call(s, "docs_index", {})).text).toBe(index());
    // An eval thread's flag never changes: set with triggers off (one statement batch).
    await fx.admin.query(
      `BEGIN; SET LOCAL session_replication_role = replica;
       UPDATE threads SET skill_eval = true WHERE id = '${s.threadId}'; COMMIT;`,
    );
    expect(await listNames(s)).toEqual(withDocs());
    expect((await call(s, "docs_index", {})).text).toBe(index());
  });

  it("need no permission and never count against the admin read limit", async () => {
    const w = await world("read");
    const s = await sandboxFor(w.team, w.admin);
    await setSite("kobe_mcp.reads_per_minute", "1");
    for (let i = 0; i < 3; i++) expect((await call(s, "docs_index", {})).isError).toBeUndefined();
    expect((await call(s, "team_members_list", {})).isError).toBeUndefined();
    expect((await call(s, "team_members_list", {})).isError).toBe(true);
    expect((await call(s, "docs_index", {})).isError).toBeUndefined();
  });

  it("attach to every run whatever the agent's connector list; admin tools follow it (KA7)", async () => {
    const w = await world("read_write");
    const names = (server: Awaited<ReturnType<typeof kobeRunServer>>) =>
      (server?.tools ?? []).map((t) => t.name).sort();
    const runServer = (
      frontmatter: Parameters<typeof kobeRunServer>[1]["frontmatter"],
      answerable = true,
      off: ReadonlySet<string> = new Set(),
    ) =>
      withTeam(fx.db, w.team, (tx) =>
        kobeRunServer(tx, { teamId: w.team, userId: w.admin.id, answerable, frontmatter, off }),
      );
    const agent = (extra: Record<string, unknown> = {}) =>
      ({ name: "A", role: "r", description: "d", ...extra }) as never;
    // No connectors named, no agent at all, a scheduled run: docs tools only.
    expect(names(await runServer(agent()))).toEqual(DOCS);
    expect(names(await runServer(undefined))).toEqual(DOCS);
    expect(names(await runServer(agent({ connectors: "all" }), false))).toEqual(DOCS);
    // Naming the connector adds the admin tools the person may use.
    expect(names(await runServer(agent({ connectors: "all" })))).toEqual(
      withDocs(...KOBE_ADMIN_TOOLS.filter((t) => t.scope === "team").map((t) => t.name)),
    );
    // The agent's tool globs still apply; the thread's off switch and the site's off remove all.
    expect(names(await runServer(agent({ tools: { deny: [`${pi("docs_full")}`] } })))).toEqual(
      DOCS.filter((d) => d !== "docs_full"),
    );
    expect(await runServer(agent(), true, new Set([KOBE_BUILTIN_CONNECTOR_ID]))).toBeUndefined();
    await setSite(KOBE_MCP_MODE_KEY, "off");
    expect(await runServer(agent())).toBeUndefined();
  });
});

describe("writes ask in every mode (ac-2, ac-3) and run exactly what was approved (ac-4)", () => {
  it("denies a write without a verified approval, runs it once with one, denies the replay", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    const input = { user_id: w.target.id, from_role: "member", to_role: "contributor" };
    const without = await call(s, "team_members_set_role", input);
    expect(without.isError).toBe(true);
    expect((await decisions(w.team)).at(-1)).toMatchObject({
      decision: "denied",
      approvalFailure: "no_approval",
    });
    expect(await roleOf(w.team, w.target.id)).toBe("member");

    const approval = await approve(s, "team_members_set_role", input);
    const once = await call(s, "team_members_set_role", input, approval.toolCallId);
    expect(once.isError).toBeUndefined();
    expect(once.structured).toEqual({ user_id: w.target.id, role: "contributor" });
    expect(await roleOf(w.team, w.target.id)).toBe("contributor");

    // The replay (same tool call id, then none) finds the approval consumed.
    const replay = await call(s, "team_members_set_role", input, approval.toolCallId);
    expect(replay.isError).toBe(true);
    expect((await call(s, "team_members_set_role", input)).isError).toBe(true);
    const consumed = await fx.admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE team_id = $1 AND action = 'approval.consumed'`,
      [w.team],
    );
    expect(consumed.rows[0]).toEqual({ n: 1 });
  });

  it("an allow rule (team allow-list, the user's remembered rule) never stands in for asking", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    await fx.admin.query(
      `INSERT INTO tool_rules (team_id, scope, effect, tool_glob, created_by)
       VALUES ($1, 'team', 'allow', $3, $2)`,
      [w.team, w.admin.id, pi("team_members_set_role")],
    );
    const input = { user_id: w.target.id, from_role: "member", to_role: "team_admin" };
    const out = await call(s, "team_members_set_role", input);
    expect(out.isError).toBe(true);
    expect((await decisions(w.team)).at(-1)).toMatchObject({ approvalFailure: "no_approval" });
    // In auto mode (where the team allow rule would allow any other write) it is denied outright.
    await fx.admin.query(`UPDATE runs SET approval_mode = 'auto' WHERE id = $1`, [s.runId]);
    await approve(s, "team_members_set_role", input);
    const auto = await call(s, "team_members_set_role", input);
    expect(auto.isError).toBe(true);
    expect((await decisions(w.team)).at(-1)).toMatchObject({ reason: "kobe_admin_write" });
    expect(await roleOf(w.team, w.target.id)).toBe("member");
  });

  it("refuses with changed_since_approval when the before-state moved; nothing changes", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    // The person approved "contributor → team admin", but the target is a member now.
    const input = { user_id: w.target.id, from_role: "contributor", to_role: "team_admin" };
    await approve(s, "team_members_set_role", input);
    const out = await call(s, "team_members_set_role", input);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("changed_since_approval");
    expect(await roleOf(w.team, w.target.id)).toBe("member");
  });

  it("caps writes per person per hour (site setting)", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    await setSite("kobe_mcp.writes_per_hour", "1");
    const first = { user_id: w.target.id, from_role: "member", to_role: "contributor" };
    await approve(s, "team_members_set_role", first);
    expect((await call(s, "team_members_set_role", first)).isError).toBeUndefined();
    const second = { user_id: w.target.id, from_role: "contributor", to_role: "member" };
    await approve(s, "team_members_set_role", second);
    const limited = await call(s, "team_members_set_role", second);
    expect(limited.isError).toBe(true);
    expect((await decisions(w.team)).at(-1)).toMatchObject({ reason: "kobe_admin_rate_limited" });
    expect(await roleOf(w.team, w.target.id)).toBe("contributor");
  });
});

describe("audit records the person via agent (ac-5)", () => {
  it("the console's own event, actor the person, with thread, run and tool call; chain verifies", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    const input = { user_id: w.target.id, from_role: "member", to_role: "team_admin" };
    const approval = await approve(s, "team_members_set_role", input);
    expect(
      (await call(s, "team_members_set_role", input, approval.toolCallId)).isError,
    ).toBeUndefined();
    const { rows } = await fx.admin.query<{
      actor_kind: string;
      actor_id: string;
      target: Record<string, unknown>;
      ip: string | null;
    }>(
      `SELECT actor_kind, actor_id, target, ip FROM audit_log
        WHERE team_id = $1 AND action = 'identity.member.role_changed' ORDER BY seq`,
      [w.team],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_kind: "user",
      actor_id: w.admin.id,
      ip: null,
      target: {
        userId: w.target.id,
        from: "member",
        to: "team_admin",
        viaAgent: { threadId: s.threadId, runId: s.runId, toolCallId: approval.toolCallId },
      },
    });
    expect((await verifyAuditChain(fx.db)).ok).toBe(true);
  });
});

describe("no header or route on the public listener accepts a delegation (ac-6)", () => {
  it("a real HTTP request with every plausible delegation claim is unauthenticated", async () => {
    const w = await world();
    const app = fx.replica(0).app;
    const server = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    try {
      const { port } = server.address() as AddressInfo;
      const delegation = {
        userId: w.admin.id,
        teamId: w.team,
        runId: randomUUID(),
        threadId: randomUUID(),
        toolCallId: "t1",
      };
      const claim = JSON.stringify(delegation);
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/team/members/${w.target.id}?delegation=${encodeURIComponent(claim)}`,
        {
          method: "PATCH",
          headers: {
            origin: PUBLIC_URL,
            "content-type": "application/json",
            "x-kobe-team": w.team,
            "kobe-delegation": claim,
            "x-kobe-delegation": claim,
            "kobe-sandbox-token": mcpToken({
              sandboxId: randomUUID(),
              teamId: w.team,
              userId: w.admin.id,
            }),
            authorization: `Bearer ${INTERNAL_KEY}`,
          },
          body: JSON.stringify({ role: "team_admin", delegation }),
        },
      );
      expect(res.status).toBe(401);
      expect(await roleOf(w.team, w.target.id)).toBe("member");
      // The Kobe endpoints exist on the internal listener only.
      for (const path of ["/internal/v1/mcp/kobe/calls", "/v1/internal/v1/mcp/kobe/calls"]) {
        const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST" });
        // 403: the CSRF origin check answers first for a POST without the site's origin.
        expect([401, 403, 404], path).toContain(r.status);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("an in-process env without a minted delegation is not one either", async () => {
    const w = await world();
    const app = fx.replica(0).app;
    const forged = {
      [Symbol.for("kobe.delegation")]: { userId: w.admin.id, teamId: w.team },
      [Symbol("kobe.delegation")]: {
        userId: w.admin.id,
        teamId: w.team,
        runId: randomUUID(),
        threadId: randomUUID(),
        toolCallId: "t",
      },
      delegation: { userId: w.admin.id, teamId: w.team },
    };
    const res = await app.request(
      `/v1/team/members/${w.target.id}`,
      {
        method: "PATCH",
        headers: { origin: PUBLIC_URL, "content-type": "application/json", "x-kobe-team": w.team },
        body: JSON.stringify({ role: "team_admin" }),
      },
      forged,
    );
    expect(res.status).toBe(401);
    expect(await roleOf(w.team, w.target.id)).toBe("member");
  });
});

// The catalog contract for every Team console tool (without the permission: not listed and
// refused; with it: listed and working; the console's own audit event) is in
// `kobe-mcp-team.db.test.ts` (KOBE-621).

describe("review fixes (KOBE-619)", () => {
  it("M1: signing out everywhere mid-run stops the run's admin tools", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    expect((await call(s, "team_members_list", {})).isError).toBeUndefined();
    await fx.replica(0).deps.revokeAllSessions(w.admin.id);
    const after = await call(s, "team_members_list", {});
    expect(after.isError).toBe(true);
    // Signing in again later does not revive a run started before the revocation.
    const again = await new TestBrowser(fx.replica(0).app, PUBLIC_URL).post(
      "/api/auth/sign-in/email",
      { email: w.admin.email, password: "a long enough password" },
    );
    expect(again.status).toBe(200);
    expect((await call(s, "team_members_list", {})).isError).toBe(true);
  });

  it("SSO review A: an SSO-backed delegation obeys the kill switch and max_session_hours", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    expect((await call(s, "team_members_list", {})).isError).toBeUndefined();
    // The person's sessions are SSO sign-ins of a provider capping them at 1 hour.
    const { rows } = await fx.admin.query<{ id: string }>(
      `INSERT INTO sso_providers (slug, display_name, kind, issuer, client_id, subject_claim, access_claim, max_session_hours, managed_by)
       VALUES ($1, 'P', 'oidc', 'https://idp.example.com', 'c', 'sub', 'groups', 1, 'helm') RETURNING id`,
      [`p-${randomUUID().slice(0, 8)}`],
    );
    const providerId = rows[0]?.id;
    await fx.admin.query(
      `INSERT INTO session_sso_contexts (session_id, provider_id, mfa_satisfied)
       SELECT id, $2, false FROM sessions WHERE user_id = $1`,
      [w.admin.id, providerId],
    );
    const db = fx.replica(0).deps.database.db;
    const d = {
      userId: w.admin.id,
      teamId: w.team,
      runId: s.runId,
      threadId: s.threadId,
      toolCallId: "tc",
    };
    // This fixture runs with single sign-on off: the kill switch refuses the delegation.
    expect(fx.replica(0).deps.sso.settings.enabled).toBe(false);
    expect((await call(s, "team_members_list", {})).isError).toBe(true);
    expect(await delegationBacked(db, d, { ssoEnabled: false })).toBe(false);
    // With SSO on, the backing session counts while within its provider's hours.
    expect(await delegationBacked(db, d, { ssoEnabled: true })).toBe(true);
    await fx.admin.query(
      `UPDATE sessions SET created_at = created_at - interval '2 hours' WHERE user_id = $1`,
      [w.admin.id],
    );
    expect(await delegationBacked(db, d, { ssoEnabled: true })).toBe(false);
  });

  it("KOBE-629: under require_2fa a delegation without TOTP needs an MFA-proving SSO backing session", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    const { rows } = await fx.admin.query<{ id: string }>(
      `INSERT INTO sso_providers (slug, display_name, kind, issuer, client_id, subject_claim, access_claim, managed_by)
       VALUES ($1, 'P', 'oidc', 'https://idp.example.com', 'c', 'sub', 'groups', 'helm') RETURNING id`,
      [`p-${randomUUID().slice(0, 8)}`],
    );
    await fx.admin.query(
      `INSERT INTO session_sso_contexts (session_id, provider_id, mfa_satisfied)
       SELECT id, $2, false FROM sessions WHERE user_id = $1`,
      [w.admin.id, rows[0]?.id],
    );
    const db = fx.replica(0).deps.database.db;
    const d = {
      userId: w.admin.id,
      teamId: w.team,
      runId: s.runId,
      threadId: s.threadId,
      toolCallId: "tc",
    };
    const opts = { ssoEnabled: true, ssoMfaProof: true };
    expect(await delegationBacked(db, d, { ssoEnabled: true })).toBe(true);
    expect(await delegationBacked(db, d, opts)).toBe(false);
    await fx.admin.query(
      `UPDATE session_sso_contexts SET mfa_satisfied = true
        WHERE session_id IN (SELECT id FROM sessions WHERE user_id = $1)`,
      [w.admin.id],
    );
    expect(await delegationBacked(db, d, opts)).toBe(true);
  });

  it("L3: the role change itself refuses another before-state (409 changed_since_approval)", async () => {
    const w = await world();
    const res = await w.admin.browser.patch(`/v1/team/members/${w.target.id}`, {
      role: "team_admin",
      expectedRole: "contributor",
    });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "changed_since_approval" });
    expect(await roleOf(w.team, w.target.id)).toBe("member");
    const ok = await w.admin.browser.patch(`/v1/team/members/${w.target.id}`, {
      role: "contributor",
      expectedRole: "member",
    });
    expect(ok.status).toBe(200);
  });

  it("L4: a target who left the team is not_a_member, not changed_since_approval", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    const input = { user_id: w.target.id, from_role: "member", to_role: "contributor" };
    await approve(s, "team_members_set_role", input);
    await fx.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      w.team,
      w.target.id,
    ]);
    const out = await call(s, "team_members_set_role", input);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("not_a_member");
  });

  it("L5: concurrent writes cannot both pass the per-person limit", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    await setSite("kobe_mcp.writes_per_hour", "1");
    const a = { user_id: w.target.id, from_role: "member", to_role: "contributor" };
    const b = { user_id: w.member.id, from_role: "member", to_role: "contributor" };
    await approve(s, "team_members_set_role", a);
    await approve(s, "team_members_set_role", b);
    const outs = await Promise.all([
      call(s, "team_members_set_role", a),
      call(s, "team_members_set_role", b),
    ]);
    expect(outs.filter((o) => o.isError === undefined)).toHaveLength(1);
    const allowed = (await decisions(w.team)).filter(
      (d) => d.decision === "allowed" && d.risk !== "read",
    );
    expect(allowed).toHaveLength(1);
  });
});

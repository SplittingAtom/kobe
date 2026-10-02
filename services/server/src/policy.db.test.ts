import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import {
  builtinToolDescriptor,
  policyDecisionSchema,
  type PolicyDecision,
  type PolicyEngine,
} from "@kobe/protocol";
import { createApp } from "./app.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { createPolicyEngine } from "./policy/engine.js";
import { insertUserAllowRule } from "./policy/remember.js";
import { createDbRuleSource, createDbSettingsSource, createTeamRule } from "./policy/rule-store.js";
import { TestBrowser, type TestResponse } from "./testing/browser.js";
import { policyInput, type InputOptions } from "./testing/policy-fixtures.js";

const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";

let database: TestDatabase;
let deps: ServerDeps;
let app: ReturnType<typeof createApp>;
let engine: PolicyEngine;

const people = ["owner", "installAdmin", "alice", "bob", "carol", "dave", "erin"] as const;
type Person = (typeof people)[number];
const ids = Object.fromEntries(people.map((p) => [p, ""])) as Record<Person, string>;
const email = (who: Person) => `${who.toLowerCase()}@policy.test`;
let as: Record<Person, TestBrowser>;
let finance = "";
let marketing = "";

// finance: alice team_admin, bob member, carol builder, erin member. marketing: dave team_admin.
// installAdmin and owner are in no team.

async function signIn(who: Person): Promise<TestBrowser> {
  const b = new TestBrowser(app, PUBLIC_URL);
  const res = await b.post("/api/auth/sign-in/email", { email: email(who), password: PASSWORD });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return b;
}

async function activate(who: Person, teamId: string): Promise<void> {
  const res = await as[who].put("/v1/me/teams/active", { teamId });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  as[who].team = teamId;
}

async function createTeam(slug: string, admin: Person): Promise<string> {
  const res = await as.installAdmin.post("/v1/install/teams", {
    slug,
    name: slug,
    adminUserId: ids[admin],
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.team.id as string;
}

async function addMember(teamAdmin: Person, who: Person, role: string): Promise<void> {
  const res = await as[teamAdmin].post("/v1/team/members", { email: email(who), role });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
}

function decide(
  who: Person,
  teamId: string,
  tool: string,
  input: Record<string, unknown> = {},
  options: InputOptions = {},
): Promise<PolicyDecision> {
  const descriptor = builtinToolDescriptor(tool);
  if (!descriptor) throw new Error(tool);
  const base = policyInput(descriptor, input as never, options);
  return engine.decide({ ...base, team_id: teamId, actor: { ...base.actor, user_id: ids[who] } });
}

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  deps = createServerDeps({
    databaseUrl: database.appUrl,
    publicUrl: PUBLIC_URL,
    authSecret: "p".repeat(48),
    setupToken: "setup-token-for-policy-tests-01",
    trustedProxies: ["127.0.0.1/32"],
  });
  app = createApp(deps);
  engine = createPolicyEngine({
    rules: createDbRuleSource(deps.database.db),
    settings: createDbSettingsSource(deps.database.db, 0),
  });
  for (const who of people) {
    const installRole = who === "owner" ? "owner" : who === "installAdmin" ? "admin" : undefined;
    const user = await deps.createUserWithPassword(
      { email: email(who), name: who, password: PASSWORD },
      installRole ? { installRole } : {},
    );
    ids[who] = user.id;
  }
  as = Object.fromEntries(
    await Promise.all(people.map(async (w) => [w, await signIn(w)])),
  ) as Record<Person, TestBrowser>;
  finance = await createTeam("finance", "alice");
  marketing = await createTeam("marketing", "dave");
  await activate("alice", finance);
  await activate("dave", marketing);
  await addMember("alice", "bob", "member");
  await addMember("alice", "carol", "builder");
  await addMember("alice", "erin", "member");
  for (const who of ["bob", "carol", "erin"] as const) await activate(who, finance);
});

/** Waits until the app role has no sessions left, so dropping the database can't kill live ones. */
async function waitForAppSessionsToClose(): Promise<void> {
  const server = new pg.Client({ connectionString: testServerUrl() });
  await server.connect();
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await server.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1`,
        [database.appRole],
      );
      if (rows[0]?.n === 0) return;
      if (Date.now() > deadline) throw new Error("app-role sessions still open after 10 s");
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await server.end();
  }
}

afterAll(async () => {
  await deps?.close();
  if (database) {
    await waitForAppSessionsToClose();
    await database.drop();
  }
});

const status = (res: TestResponse) => res.status;

/** Superuser query on the test database (bypasses RLS: fixtures and assertions only). */
async function adminQuery<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  const client = new pg.Client({ connectionString: database.adminUrl });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

describe("install policy routes (D8: install Owner/Admin)", () => {
  const path = "/v1/install/policy/rules";

  it("refuses plain users and team admins", async () => {
    expect(status(await as.alice.get(path))).toBe(403);
    expect(status(await as.bob.post(path, { effect: "deny", tool_glob: "bash" }))).toBe(403);
    expect(status(await as.dave.get("/v1/install/policy/settings"))).toBe(403);
  });

  it("lets install admins and the Owner create, list, update and delete floor rules", async () => {
    const created = await as.installAdmin.post(path, {
      effect: "ask",
      tool_glob: "mcp__*",
      note: "Ask before any connector call",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.json.rule).toMatchObject({
      scope: "install",
      scope_ref: null,
      effect: "ask",
      tool_glob: "mcp__*",
      arg_pattern: null,
      created_by: ids.installAdmin,
      expires_at: null,
    });
    const id = created.json.rule.id as string;
    expect((await as.owner.get(path)).json.rules.map((r: { id: string }) => r.id)).toContain(id);
    const updated = await as.owner.put(`${path}/${id}`, {
      effect: "deny",
      tool_glob: "mcp__*",
      arg_pattern: { "/force": "true" },
    });
    expect(updated.status, JSON.stringify(updated.json)).toBe(200);
    expect(updated.json.rule).toMatchObject({ effect: "deny", arg_pattern: { "/force": "true" } });
    expect(status(await as.installAdmin.delete(`${path}/${id}`))).toBe(204);
    expect(status(await as.installAdmin.delete(`${path}/${id}`))).toBe(404);
    expect(
      status(
        await as.installAdmin.put(`${path}/${randomUUID()}`, { effect: "deny", tool_glob: "x" }),
      ),
    ).toBe(404);
  });

  it.each([
    ["allow (the floor only tightens)", { effect: "allow", tool_glob: "read" }],
    ["missing glob", { effect: "deny" }],
    ["empty glob", { effect: "deny", tool_glob: "" }],
    ["trailing escape", { effect: "deny", tool_glob: "bash\\" }],
    ["over-long glob", { effect: "deny", tool_glob: "a".repeat(257) }],
    ["regex-shaped pointer", { effect: "deny", tool_glob: "bash", arg_pattern: { command: "x" } }],
    ["root pointer", { effect: "deny", tool_glob: "bash", arg_pattern: { "": "x" } }],
    ["bad pointer escape", { effect: "deny", tool_glob: "bash", arg_pattern: { "/a~2": "x" } }],
    ["empty arg pattern", { effect: "deny", tool_glob: "bash", arg_pattern: {} }],
    [
      "too many arg entries",
      {
        effect: "deny",
        tool_glob: "bash",
        arg_pattern: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`/k${i}`, "*"])),
      },
    ],
    ["non-string glob value", { effect: "deny", tool_glob: "bash", arg_pattern: { "/a": 1 } }],
    ["expired", { effect: "deny", tool_glob: "bash", expires_at: "2020-01-01T00:00:00Z" }],
    ["unknown field", { effect: "deny", tool_glob: "bash", scope: "team" }],
    ["long note", { effect: "deny", tool_glob: "bash", note: "n".repeat(501) }],
  ])("rejects %s", async (_name, body) => {
    const res = await as.installAdmin.post(path, body);
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(res.json.code).toBe("invalid_request");
  });

  it("rejects a non-uuid rule id", async () => {
    expect(status(await as.installAdmin.delete(`${path}/1`))).toBe(400);
  });

  it("flips the sandbox-writes switch (install admins only) and the engine follows it", async () => {
    expect((await as.installAdmin.get("/v1/install/policy/settings")).json).toEqual({
      promptSandboxWrites: false,
    });
    expect((await decide("bob", finance, "bash", { command: "ls" })).effect).toBe("allow");
    const on = await as.installAdmin.put("/v1/install/policy/settings", {
      promptSandboxWrites: true,
    });
    expect(on.status).toBe(200);
    expect((await decide("bob", finance, "bash", { command: "ls" })).effect).toBe(
      "require_approval",
    );
    expect(
      status(
        await as.installAdmin.put("/v1/install/policy/settings", { promptSandboxWrites: "no" }),
      ),
    ).toBe(400);
    await as.owner.put("/v1/install/policy/settings", { promptSandboxWrites: false });
    expect((await decide("bob", finance, "bash", { command: "ls" })).effect).toBe("allow");
  });
});

describe("team policy routes (D8: team admins manage, members read)", () => {
  const path = "/v1/team/policy/rules";

  it("needs a team: install admins outside the team get nothing", async () => {
    expect(status(await as.installAdmin.get(path))).toBe(409); // no active team
    const forced = await as.installAdmin.get(path, { "x-kobe-team": finance });
    expect(forced.status).toBe(409);
  });

  it("refuses rule changes to members and builders", async () => {
    for (const who of ["bob", "carol"] as const) {
      expect(status(await as[who].post(path, { effect: "deny", tool_glob: "bash" }))).toBe(403);
    }
  });

  it("lets team admins manage rules and members read them", async () => {
    const created = await as.alice.post(path, {
      effect: "ask",
      tool_glob: "create_artifact",
      expires_at: "2099-01-01T00:00:00Z",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.json.rule).toMatchObject({
      scope: "team",
      scope_ref: finance,
      effect: "ask",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    const id = created.json.rule.id as string;
    const listed = await as.bob.get(path);
    expect(listed.status).toBe(200);
    expect(listed.json.rules.map((r: { id: string }) => r.id)).toEqual([id]);
    const updated = await as.alice.put(`${path}/${id}`, {
      effect: "allow",
      tool_glob: "create_artifact",
    });
    expect(updated.json.rule).toMatchObject({ effect: "allow", expires_at: null });
    expect(status(await as.bob.delete(`${path}/${id}`))).toBe(403);
    expect(status(await as.alice.delete(`${path}/${id}`))).toBe(204);
  });

  it("refuses blanket team allow rules (no bypass)", async () => {
    for (const tool_glob of ["*", "mcp__*", "b*"]) {
      const res = await as.alice.post(path, { effect: "allow", tool_glob });
      expect(res.status, tool_glob).toBe(400);
    }
    const scoped = await as.alice.post(path, { effect: "allow", tool_glob: "mcp__jira__*" });
    expect(scoped.status).toBe(201);
    expect(status(await as.alice.delete(`${path}/${scoped.json.rule.id}`))).toBe(204);
    // Deny and ask rules may be as broad as the team likes.
    const broad = await as.alice.post(path, { effect: "ask", tool_glob: "*" });
    expect(broad.status).toBe(201);
    expect(status(await as.alice.delete(`${path}/${broad.json.rule.id}`))).toBe(204);
  });

  it("requires the X-Kobe-Team header on changes", async () => {
    const b = await signIn("alice");
    await b.put("/v1/me/teams/active", { teamId: finance });
    expect(status(await b.post(path, { effect: "deny", tool_glob: "bash" }))).toBe(400);
  });

  it("keeps teams apart: another team's admin can't see, change or delete a rule", async () => {
    const created = await as.alice.post(path, { effect: "deny", tool_glob: "powershell" });
    const id = created.json.rule.id as string;
    expect((await as.dave.get(path)).json.rules).toEqual([]);
    expect(status(await as.dave.put(`${path}/${id}`, { effect: "ask", tool_glob: "*" }))).toBe(404);
    expect(status(await as.dave.delete(`${path}/${id}`))).toBe(404);
    // The finance deny applies in finance only.
    expect((await decide("bob", finance, "powershell", { command: "x" })).effect).toBe("deny");
    expect((await decide("dave", marketing, "powershell", { command: "x" })).effect).toBe("allow");
    // A finance admin can't reach marketing by naming it in the header.
    expect(
      (await as.alice.request("DELETE", `${path}/${id}`, undefined, { "x-kobe-team": marketing }))
        .status,
    ).toBe(409);
    expect(status(await as.alice.delete(`${path}/${id}`))).toBe(204);
  });

  it("caps rules per scope", async () => {
    const db = deps.database.db;
    const fields = { tool_glob: "x", arg_pattern: null, note: null, expires_at: null };
    const first = await createTeamRule(db, marketing, { ...fields, effect: "deny" }, ids.dave, 1);
    expect(first.ok).toBe(true);
    const second = await createTeamRule(db, marketing, { ...fields, effect: "deny" }, ids.dave, 1);
    expect(second).toEqual({ ok: false, error: "too_many_rules" });
    if (first.ok) await as.dave.delete(`${path}/${first.rule.id}`);
  });
});

describe("D29 order end to end (rules from Postgres)", () => {
  const install = "/v1/install/policy/rules";
  const team = "/v1/team/policy/rules";
  const created: { path: string; id: string; by: Person }[] = [];

  async function make(by: Person, path: string, body: object): Promise<string> {
    const res = await as[by].post(path, body);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    created.push({ path, id: res.json.rule.id, by });
    return res.json.rule.id as string;
  }

  async function cleanup(): Promise<void> {
    for (const r of created.splice(0)) await as[r.by].delete(`${r.path}/${r.id}`);
  }

  async function remember(who: Person, teamId: string, tool: string, rememberRule: object) {
    return withTeam(deps.database.db, teamId, (tx) =>
      insertUserAllowRule(tx, {
        teamId,
        userId: ids[who],
        approvedTool: tool,
        remember: rememberRule,
        now: new Date(),
      }),
    );
  }

  it("install deny beats a team allow and the user's own allow", async () => {
    await make("installAdmin", install, { effect: "deny", tool_glob: "share_file" });
    await make("alice", team, { effect: "allow", tool_glob: "share_file" });
    expect((await remember("bob", finance, "share_file", { tool_glob: "share_file" })).ok).toBe(
      true,
    );
    const decision = await decide("bob", finance, "share_file", { path: "/workspace/a" });
    expect(decision.effect).toBe("deny");
    expect(decision.reasons[0]).toMatchObject({
      code: "install_deny_rule",
      rule_id: created[0]?.id,
    });
    expect(policyDecisionSchema.safeParse(decision).success).toBe(true);
    await cleanup();
  });

  it("an install ask can't be removed by a remember-rule; without it the remember-rule allows", async () => {
    const askId = await make("installAdmin", install, {
      effect: "ask",
      tool_glob: "update_artifact",
    });
    expect(
      (await remember("bob", finance, "update_artifact", { tool_glob: "update_artifact" })).ok,
    ).toBe(true);
    const asked = await decide("bob", finance, "update_artifact");
    expect(asked).toMatchObject({ effect: "require_approval" });
    expect(asked.reasons[0]).toMatchObject({ code: "install_ask_rule", rule_id: askId });
    await cleanup();
    const allowed = await decide("bob", finance, "update_artifact");
    expect(allowed.effect).toBe("allow");
    expect(allowed.reasons[0]?.code).toBe("user_allow_rule");
  });

  it("a remember-rule applies to its owner in its team only", async () => {
    expect(
      (await remember("erin", finance, "create_artifact", { tool_glob: "create_artifact" })).ok,
    ).toBe(true);
    expect((await decide("erin", finance, "create_artifact")).effect).toBe("allow");
    expect((await decide("bob", finance, "create_artifact")).effect).toBe("require_approval");
    // erin is not in marketing; dave's decision there ignores erin's finance rule.
    expect((await decide("dave", marketing, "create_artifact")).effect).toBe("require_approval");
  });

  it("members list and revoke only their own remember-rules", async () => {
    const mine = await as.erin.get("/v1/team/policy/my-rules");
    expect(mine.status).toBe(200);
    const rule = mine.json.rules.find(
      (r: { tool_glob: string }) => r.tool_glob === "create_artifact",
    );
    expect(rule).toMatchObject({ scope: "user", scope_ref: ids.erin, effect: "allow" });
    expect(
      (await as.bob.get("/v1/team/policy/my-rules")).json.rules.map(
        (r: { scope_ref: string }) => r.scope_ref,
      ),
    ).not.toContain(ids.erin);
    expect(status(await as.bob.delete(`/v1/team/policy/my-rules/${rule.id}`))).toBe(404);
    // Team rule routes never touch user rules.
    expect(status(await as.alice.delete(`/v1/team/policy/rules/${rule.id}`))).toBe(404);
    expect(status(await as.erin.delete(`/v1/team/policy/my-rules/${rule.id}`))).toBe(204);
    expect((await decide("erin", finance, "create_artifact")).effect).toBe("require_approval");
  });

  it("remember-rules: validation, scope to the approved tool, expiry", async () => {
    expect(await remember("bob", finance, "bash", { tool_glob: "*" })).toEqual({
      ok: false,
      error: "glob_too_broad",
    });
    expect(
      await remember("bob", finance, "bash", { tool_glob: "bash", arg_pattern: { x: "y" } }),
    ).toEqual({
      ok: false,
      error: "invalid_rule",
    });
    expect(await remember("bob", finance, "bash", { tool_glob: "bash", extra: 1 })).toEqual({
      ok: false,
      error: "invalid_rule",
    });
    const timed = await remember("bob", finance, "edit", {
      tool_glob: "edit",
      arg_pattern: { "/path": "/workspace/*" },
      expires_in: 3600,
    });
    expect(timed.ok && timed.rule.expires_at).toBeTruthy();
    expect(timed.ok && Date.parse(timed.rule.expires_at ?? "") - Date.now()).toBeGreaterThan(
      3500_000,
    );
  });

  it("refuses a remember-rule for someone outside the team", async () => {
    await expect(remember("dave", finance, "bash", { tool_glob: "bash" })).rejects.toThrow();
  });

  it("ignores expired rules from Postgres", async () => {
    // The engine's clock decides expiry (the database server's clock may differ).
    await adminQuery(
      `UPDATE tool_rules SET expires_at = $1 WHERE scope = 'user' AND tool_glob = 'edit'`,
      [new Date(Date.now() - 1000)],
    );
    await as.installAdmin.put("/v1/install/policy/settings", { promptSandboxWrites: true });
    expect((await decide("bob", finance, "edit", { path: "/workspace/x" })).effect).toBe(
      "require_approval",
    );
    await as.installAdmin.put("/v1/install/policy/settings", { promptSandboxWrites: false });
  });

  it("drops a user's remember-rules when they leave the team", async () => {
    expect((await remember("bob", finance, "recall", { tool_glob: "recall" })).ok).toBe(true);
    const before = await as.bob.get("/v1/team/policy/my-rules");
    expect(before.json.rules.length).toBeGreaterThan(0);
    expect(status(await as.alice.delete(`/v1/team/members/${ids.bob}`))).toBe(204);
    const rows = await adminQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM tool_rules WHERE user_id = $1`,
      [ids.bob],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("scheduled runs never wait: an ask rule becomes a deny", async () => {
    await make("alice", team, { effect: "ask", tool_glob: "grep" });
    const decision = await decide(
      "carol",
      finance,
      "grep",
      { pattern: "x" },
      { mode: "auto", kind: "schedule" },
    );
    expect(decision.effect).toBe("deny");
    expect(decision.reasons.map((r) => r.code)).toEqual([
      "scheduled_run_no_prompt",
      "team_ask_rule",
    ]);
    await cleanup();
  });
});

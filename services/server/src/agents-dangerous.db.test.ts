import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { createApp } from "./app.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { waitForAppSessionsToClose } from "./testing/app-sessions.js";
import { RawBody, TestBrowser, type TestResponse } from "./testing/browser.js";
import { MemoryMailer } from "./testing/mailer.js";

/**
 * Dangerous mode over HTTP (AC1, KOBE-476): only site admins and team admins may create, import,
 * keep, publish or roll back an agent in Dangerous mode; a non-admin's fork drops it; turning it on
 * or off is audited; summaries and the runnable list carry the flag for the badges.
 */
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";
const ANY = { "if-match": "*" };

type Person = "siteAdmin" | "alice" | "bob" | "carol";
// Finance: siteAdmin member (site Admin), alice team_admin, bob builder, carol member.
const PEOPLE: readonly Person[] = ["siteAdmin", "alice", "bob", "carol"];
const ids = {} as Record<Person, string>;
const as = {} as Record<Person, TestBrowser>;
const finance = randomUUID();

let database: TestDatabase;
let deps: ServerDeps;
let admin: pg.Client;

const json = (res: TestResponse) => JSON.stringify(res.json);
const dangerous = (name: string, extra: object = {}) => ({
  frontmatter: { name, approval_mode: "dangerous", ...extra },
  prompt: `You are ${name}.`,
});
const plain = (name: string) => ({ frontmatter: { name }, prompt: `You are ${name}.` });

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  deps = createServerDeps({
    databaseUrl: database.appUrl,
    publicUrl: PUBLIC_URL,
    authSecret: "t".repeat(48),
    setupToken: "setup-token-for-dangerous-tests-01",
    trustedProxies: ["127.0.0.1/32"],
    mailer: new MemoryMailer(),
  });
  const app = createApp(deps);
  // The first account is the Owner; make a throwaway one so siteAdmin is a plain Admin.
  await deps.createUserWithPassword(
    { email: "owner@dangerous.test", name: "owner", password: PASSWORD },
    { siteRole: "owner" },
  );
  for (const who of PEOPLE) {
    const user = await deps.createUserWithPassword(
      { email: `${who}@dangerous.test`, name: who, password: PASSWORD },
      who === "siteAdmin" ? { siteRole: "admin" } : {},
    );
    ids[who] = user.id;
  }
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'finance', 'Finance')`, [
    finance,
  ]);
  const roles: [Person, string][] = [
    ["siteAdmin", "member"],
    ["alice", "team_admin"],
    ["bob", "builder"],
    ["carol", "member"],
  ];
  for (const [who, role] of roles) {
    await admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      finance,
      ids[who],
      role,
    ]);
  }
  for (const who of PEOPLE) {
    const b = new TestBrowser(app, PUBLIC_URL);
    const res = await b.post("/api/auth/sign-in/email", {
      email: `${who}@dangerous.test`,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    const active = await b.put("/v1/me/teams/active", { teamId: finance });
    expect(active.status, json(active)).toBe(200);
    b.team = finance;
    as[who] = b;
  }
});

afterAll(async () => {
  await admin?.end();
  await deps?.close();
  if (database) {
    await waitForAppSessionsToClose(database.appRole);
    await database.drop();
  }
});

async function create(who: Person, scope: "team" | "personal", body: object) {
  return as[who].post("/v1/agents", { scope, ...body });
}

async function created(who: Person, scope: "team" | "personal", body: object): Promise<string> {
  const res = await create(who, scope, body);
  expect(res.status, json(res)).toBe(201);
  return res.json.agent.id as string;
}

const publish = (who: Person, id: string) =>
  as[who].request("POST", `/v1/agents/${id}/publish`, {}, ANY);

async function changes(agentId: string) {
  const { rows } = await admin.query<{ target: { enabled: boolean } }>(
    `SELECT target FROM audit_log WHERE action = 'agent.dangerous_mode.changed'
       AND target->>'agentId' = $1 ORDER BY seq`,
    [agentId],
  );
  return rows.map((r) => r.target.enabled);
}

describe("who may set Dangerous mode (AC1)", () => {
  it("lets a team admin and a site admin create Dangerous agents, audited and flagged", async () => {
    const team = await created("alice", "team", dangerous("Ops Bot"));
    const personal = await created("siteAdmin", "personal", dangerous("Mine"));
    expect(await changes(team)).toEqual([true]);
    expect(await changes(personal)).toEqual([true]);
    const read = await as.alice.get(`/v1/agents/${team}`);
    expect(read.json.agent).toMatchObject({
      dangerous: true,
      frontmatter: { approval_mode: "dangerous" },
    });
    expect(read.json.warnings).toEqual([
      expect.objectContaining({ path: "frontmatter.approval_mode" }),
    ]);
  });

  it("refuses a builder's and a member's Dangerous agent, as JSON and as an imported file", async () => {
    for (const [who, scope] of [
      ["bob", "team"],
      ["bob", "personal"],
      ["carol", "personal"],
    ] as const) {
      const res = await create(who, scope, dangerous(`No ${who} ${scope}`));
      expect(res.status, `${who}/${scope}`).toBe(403);
      expect(res.json.code).toBe("dangerous_mode_forbidden");
    }
    const file = "---\nname: Imported\napproval_mode: dangerous\n---\nHi.\n";
    const res = await as.carol.request(
      "POST",
      "/v1/agents?scope=personal",
      new RawBody(file, "text/markdown"),
    );
    expect(res.status, json(res)).toBe(403);
  });

  it("refuses a builder setting or keeping it on their own team agent; an admin may", async () => {
    const id = await created("bob", "team", plain("Bob Agent"));
    const set = await as.bob.put(`/v1/agents/${id}`, dangerous("Bob Agent"), ANY);
    expect(set.status, json(set)).toBe(403);
    expect(set.json.code).toBe("dangerous_mode_forbidden");
    // A team admin (team.agents.manage) turns it on; the builder can't publish or keep it.
    const byAdmin = await as.alice.put(`/v1/agents/${id}`, dangerous("Bob Agent"), ANY);
    expect(byAdmin.status, json(byAdmin)).toBe(200);
    expect((await publish("bob", id)).status).toBe(403);
    const keep = await as.bob.put(`/v1/agents/${id}`, dangerous("Bob Agent v2"), ANY);
    expect(keep.status).toBe(403);
    // Turning it off is anyone's with edit rights, and audited.
    const off = await as.bob.put(`/v1/agents/${id}`, plain("Bob Agent"), ANY);
    expect(off.status, json(off)).toBe(200);
    expect(off.json.agent.dangerous).toBe(false);
    expect(await changes(id)).toEqual([true, false]);
  });

  it("lets an admin publish it; a builder can't roll back to a Dangerous version", async () => {
    // The admin turns Dangerous on in the builder's agent and publishes v1; the builder turns it
    // off and publishes v2, then may not republish v1.
    const bobs = await created("bob", "team", plain("Rollback Bot"));
    expect((await as.alice.put(`/v1/agents/${bobs}`, dangerous("Rollback Bot"), ANY)).status).toBe(
      200,
    );
    expect((await publish("alice", bobs)).status).toBe(201);
    expect((await as.bob.put(`/v1/agents/${bobs}`, plain("Rollback Bot"), ANY)).status).toBe(200);
    expect((await publish("bob", bobs)).status).toBe(201);
    const rollback = await as.bob.post(`/v1/agents/${bobs}/rollback`, { version: 1 });
    expect(rollback.status, json(rollback)).toBe(403);
    expect(rollback.json.code).toBe("dangerous_mode_forbidden");
    const byAdmin = await as.alice.post(`/v1/agents/${bobs}/rollback`, { version: 1 });
    expect(byAdmin.status, json(byAdmin)).toBe(201);
  });

  it("drops Dangerous mode from a non-admin's fork, keeps it in an admin's", async () => {
    const id = await created("alice", "team", dangerous("Forkable", { starters: ["Go"] }));
    const fork = await as.bob.post(`/v1/agents/${id}/fork`, { scope: "team" });
    expect(fork.status, json(fork)).toBe(201);
    expect(fork.json.agent.frontmatter).toEqual({ name: "Forkable", starters: ["Go"] });
    expect(fork.json.agent.dangerous).toBe(false);
    expect(await changes(fork.json.agent.id as string)).toEqual([]);
    const own = await as.alice.post(`/v1/agents/${id}/fork`, { scope: "team" });
    expect(own.status, json(own)).toBe(201);
    expect(own.json.agent.frontmatter.approval_mode).toBe("dangerous");
  });

  it("flags the published Dangerous agent in the runnable list (picker badge)", async () => {
    const id = await created("alice", "team", dangerous("Listed Bot"));
    expect((await publish("alice", id)).status).toBe(201);
    const calm = await created("alice", "team", plain("Calm Bot"));
    expect((await publish("alice", calm)).status).toBe(201);
    const res = await as.carol.get("/v1/agents/runnable");
    expect(res.status).toBe(200);
    const agents = res.json.agents as { id: string; dangerous?: boolean }[];
    expect(agents.find((a) => a.id === id)?.dangerous).toBe(true);
    expect(agents.find((a) => a.id === calm)).not.toHaveProperty("dangerous");
  });
});

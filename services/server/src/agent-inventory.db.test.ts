import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { createApp } from "./app.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { waitForAppSessionsToClose } from "./testing/app-sessions.js";
import { TestBrowser } from "./testing/browser.js";
import { MemoryMailer } from "./testing/mailer.js";

/**
 * Agent inventory and team-level suspension (KOBE-86). Own throwaway database.
 */
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";

/** If-Match for edits that aren't about concurrency: overwrite whatever is there. */
const ANY = { "if-match": "*" };
const definition = (name: string, prompt = `You are ${name}.`) => ({
  frontmatter: { name, starters: ["Hello"] },
  prompt,
});

type Person = "owner" | "alice" | "bob" | "carol" | "dave";
// Finance: alice team_admin, bob builder, carol member. Marketing: dave builder.
const PEOPLE: readonly Person[] = ["owner", "alice", "bob", "carol", "dave"];
const ids = {} as Record<Person, string>;
const as = {} as Record<Person, TestBrowser>;
const finance = randomUUID();
const marketing = randomUUID();

let database: TestDatabase;
let deps: ServerDeps;
let app: ReturnType<typeof createApp>;

async function activate(who: Person, teamId: string): Promise<void> {
  const res = await as[who].put("/v1/me/teams/active", { teamId });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  as[who].team = teamId;
}

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  deps = createServerDeps({
    databaseUrl: database.appUrl,
    publicUrl: PUBLIC_URL,
    authSecret: "t".repeat(48),
    setupToken: "setup-token-for-agent-tests-0123",
    trustedProxies: ["127.0.0.1/32"],
    mailer: new MemoryMailer(),
  });
  app = createApp(deps);
  for (const who of PEOPLE) {
    const installRole = who === "owner" ? "owner" : undefined;
    const user = await deps.createUserWithPassword(
      { email: `${who}@agents.test`, name: who, password: PASSWORD },
      installRole ? { installRole } : {},
    );
    ids[who] = user.id;
  }
  const admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO teams (id, slug, name) VALUES ($1, 'finance', 'Finance'), ($2, 'marketing', 'Marketing')`,
      [finance, marketing],
    );
    const members: [string, Person, string][] = [
      [finance, "alice", "team_admin"],
      [finance, "bob", "builder"],
      [finance, "carol", "member"],
      [marketing, "dave", "builder"],
    ];
    for (const [team, who, role] of members) {
      await admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
        team,
        ids[who],
        role,
      ]);
    }
  } finally {
    await admin.end();
  }
  for (const who of PEOPLE) {
    const b = new TestBrowser(app, PUBLIC_URL);
    const res = await b.post("/api/auth/sign-in/email", {
      email: `${who}@agents.test`,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    as[who] = b;
  }
  for (const who of ["alice", "bob", "carol"] as const) await activate(who, finance);
  await activate("dave", marketing);
});

afterAll(async () => {
  await deps?.close();
  if (database) {
    await waitForAppSessionsToClose(database.appRole);
    await database.drop();
  }
});

async function published(who: Person, scope: "team" | "personal", name: string): Promise<string> {
  const created = await as[who].post("/v1/agents", { scope, ...definition(name) });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  const pub = await as[who].request("POST", `/v1/agents/${id}/publish`, {}, ANY);
  expect(pub.status, JSON.stringify(pub.json)).toBe(201);
  return id;
}

async function sql<T extends pg.QueryResultRow>(text: string, args: unknown[] = []) {
  const admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  try {
    return (await admin.query<T>(text, args)).rows;
  } finally {
    await admin.end();
  }
}

const inventory = (who: Person, query = "") => as[who].get(`/v1/agents/inventory${query}`);
type Item = { id: string; scope: string; status: string; ownerName: string; versionCount: number };
const byId = (items: Item[], id: string) => items.find((i) => i.id === id);

describe("agent inventory (KOBE-86)", () => {
  let teamAgent: string;
  let carolPersonal: string;
  let bobUnused: string;
  let marketingAgent: string;
  let longSlug: string;

  beforeAll(async () => {
    teamAgent = await published("bob", "team", "Ledger Bot");
    carolPersonal = await published("carol", "personal", "Carol Helper");
    bobUnused = await published("bob", "personal", "Bob Private");
    marketingAgent = await published("dave", "team", "Campaign Bot");
    // A slug at the 48-character maximum sorts first, so it is the cursor of the first page.
    const long = await as.bob.post("/v1/agents", {
      scope: "team",
      slug: "a".repeat(48),
      ...definition("Long Slug"),
    });
    expect(long.status, JSON.stringify(long.json)).toBe(201);
    longSlug = long.json.agent.id as string;
    const thread = await as.carol.post("/v1/threads", { agent_id: carolPersonal });
    expect(thread.status, JSON.stringify(thread.json)).toBe(201);
    const t = await as.bob.post("/v1/threads", { agent_id: teamAgent });
    expect(t.status, JSON.stringify(t.json)).toBe(201);
    await sql(
      `INSERT INTO runs (team_id, thread_id, trigger) VALUES ($1, $2, 'user'), ($1, $2, 'user')`,
      [finance, t.json.thread_id],
    );
  });

  it("is for team admins only", async () => {
    expect((await inventory("bob")).status).toBe(403);
    expect((await inventory("carol")).status).toBe(403);
    expect((await inventory("alice")).status).toBe(200);
  });

  it("lists team agents and personal agents used in the team, with usage", async () => {
    const res = await inventory("alice");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const items = res.json.agents as Item[];
    expect(byId(items, teamAgent)).toMatchObject({
      scope: "team",
      status: "active",
      ownerName: "bob",
      currentVersion: 1,
      versionCount: 1,
      runCount: 2,
      schedules: null,
      orbitScore: null,
    });
    expect(byId(items, carolPersonal)).toMatchObject({
      scope: "personal",
      ownerName: "carol",
      runCount: 0,
    });
    expect(byId(items, bobUnused)).toBeUndefined();
    expect(byId(items, marketingAgent)).toBeUndefined();
    expect(res.json.nextCursor).toBeNull();
  });

  it("pages", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: { json: { agents: Item[]; nextCursor: string | null } } = await inventory(
        "alice",
        `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(res.json.agents.length).toBeLessThanOrEqual(1);
      seen.push(...res.json.agents.map((a) => a.id));
      cursor = res.json.nextCursor;
    } while (cursor);
    expect(seen[0]).toBe(longSlug);
    expect(seen.sort()).toEqual([carolPersonal, longSlug, teamAgent].sort());
    expect((await inventory("alice", "?cursor=garbage")).status).toBe(400);
    expect((await inventory("alice", "?limit=0")).status).toBe(400);
  });

  it("suspends and reactivates a team agent and a member's personal agent, audited", async () => {
    for (const id of [teamAgent, carolPersonal]) {
      const sus = await as.alice.put(`/v1/agents/inventory/${id}/status`, { status: "suspended" });
      expect(sus.status, JSON.stringify(sus.json)).toBe(200);
      expect(byId((await inventory("alice")).json.agents, id)?.status).toBe("suspended");
      const blocked = await as.bob.post("/v1/threads", { agent_id: teamAgent });
      if (id === teamAgent) expect(blocked.json.code).toBe("agent_unavailable");
    }
    const refused = await as.carol.post("/v1/threads", { agent_id: carolPersonal });
    expect(refused.json.code).toBe("agent_unavailable");
    // Per team: another team's use of the same personal agent is untouched.
    const rows = await sql<{ team_id: string }>(
      `SELECT team_id FROM team_agent_suspensions WHERE agent_id = $1`,
      [carolPersonal],
    );
    expect(rows).toEqual([{ team_id: finance }]);
    const audited = await sql<{ team_id: string | null }>(
      `SELECT team_id FROM audit_log WHERE action = 'agent.status_changed' AND target->>'agentId' = $1`,
      [carolPersonal],
    );
    expect(audited).toEqual([{ team_id: finance }]);

    for (const id of [teamAgent, carolPersonal]) {
      const res = await as.alice.put(`/v1/agents/inventory/${id}/status`, { status: "active" });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
    }
    expect(byId((await inventory("alice")).json.agents, carolPersonal)?.status).toBe("active");
    expect((await as.carol.post("/v1/threads", { agent_id: carolPersonal })).status).toBe(201);
  });

  it("refuses non-admins and agents the team does not have", async () => {
    const path = (id: string) => `/v1/agents/inventory/${id}/status`;
    expect((await as.bob.put(path(teamAgent), { status: "suspended" })).status).toBe(403);
    expect((await as.alice.put(path(bobUnused), { status: "suspended" })).status).toBe(404);
    expect((await as.alice.put(path(marketingAgent), { status: "suspended" })).status).toBe(404);
    expect((await as.alice.put(path(teamAgent), { status: "nope" })).status).toBe(400);
  });
});

describe("inventory queries use indexes (KOBE-86)", () => {
  it("reads threads, runs and usage through their indexes", async () => {
    const plan = async (text: string) => {
      const admin = new pg.Client({ connectionString: database.adminUrl });
      await admin.connect();
      try {
        await admin.query("SET enable_seqscan = off");
        const { rows } = await admin.query<Record<string, string>>(`EXPLAIN ${text}`, [finance]);
        return rows.map((r) => r["QUERY PLAN"]).join("\n");
      } finally {
        await admin.end();
      }
    };
    expect(
      await plan(`SELECT id FROM threads WHERE team_id = $1 AND team_agent_id = gen_random_uuid()`),
    ).toMatch(/threads_team_agent_idx/);
    expect(
      await plan(
        `SELECT id FROM threads WHERE team_id = $1 AND install_agent_id = gen_random_uuid()`,
      ),
    ).toMatch(/threads_install_agent_idx/);
    expect(
      await plan(
        `SELECT sum(input_tokens) FROM run_usage WHERE team_id = $1 AND agent_id = gen_random_uuid()`,
      ),
    ).toMatch(/run_usage_agent_idx/);
  });
});

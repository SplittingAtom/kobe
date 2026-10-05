import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { serializeAgentFile } from "@kobe/agent-file";
import { createApp } from "./app.js";
import { seedGalleryAgents } from "./gallery/seed.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { waitForAppSessionsToClose } from "./testing/app-sessions.js";
import { TestBrowser } from "./testing/browser.js";
import { MemoryMailer } from "./testing/mailer.js";

/**
 * Runnable agents for the chat picker (KOBE-122). Own throwaway database.
 */
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";

/** If-Match for edits that aren't about concurrency: overwrite whatever is there. */
const ANY = { "if-match": "*" };

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

async function published(
  who: Person,
  scope: "team" | "personal",
  name: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await as[who].post("/v1/agents", {
    scope,
    frontmatter: { name, description: `${name} does things`, ...extra },
    prompt: `You are ${name}.`,
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  const pub = await as[who].request("POST", `/v1/agents/${id}/publish`, {}, ANY);
  expect(pub.status, JSON.stringify(pub.json)).toBe(201);
  return id;
}

type Item = { id: string; scope: string; name: string; description?: string; model: string | null };
const runnable = (who: Person, query = "") => as[who].get(`/v1/agents/runnable${query}`);
const idsOf = (json: { agents: Item[] }) => json.agents.map((a) => a.id);

describe("GET /v1/agents/runnable (KOBE-122)", () => {
  let teamAgent: string;
  let pinned: string;
  let carolPersonal: string;
  let gallery: string;
  let suspendedTeam: string;
  let suspendedPersonal: string;
  let archived: string;
  let draftOnly: string;
  let marketingAgent: string;

  beforeAll(async () => {
    teamAgent = await published("bob", "team", "Ledger Bot");
    pinned = await published("bob", "team", "Pinned Bot", { model: "smart" });
    carolPersonal = await published("carol", "personal", "Carol Helper");
    suspendedTeam = await published("bob", "team", "Paused Team Bot");
    suspendedPersonal = await published("carol", "personal", "Paused Personal");
    archived = await published("bob", "team", "Old Bot");
    marketingAgent = await published("dave", "team", "Campaign Bot");
    const draft = await as.bob.post("/v1/agents", {
      scope: "team",
      frontmatter: { name: "Unpublished" },
      prompt: "x",
    });
    draftOnly = draft.json.agent.id as string;
    // Gallery agents are seeded from the repo, never created through the API (KOBE-87).
    const [seeded] = await seedGalleryAgents(deps.database.db, [
      {
        key: "gallery-bot",
        generation: 1,
        file: serializeAgentFile({
          frontmatter: { name: "Gallery Bot", description: "From the gallery" },
          prompt: "You are Gallery Bot.",
        }),
      },
    ]);
    expect(seeded?.agentId).toBeTruthy();
    gallery = seeded?.agentId ?? "";
    // An install-wide agent can be suspended for a team once its threads have used it.
    const used = await as.carol.post("/v1/threads", { agent_id: suspendedPersonal });
    expect(used.status, JSON.stringify(used.json)).toBe(201);
    for (const id of [suspendedTeam, suspendedPersonal]) {
      const res = await as.alice.put(`/v1/agents/inventory/${id}/status`, { status: "suspended" });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
    }
    const del = await as.bob.request("DELETE", `/v1/agents/${archived}`);
    expect(del.status, JSON.stringify(del.json)).toBeLessThan(300);
  });

  it("lists team, own personal and gallery agents with description and pinned model", async () => {
    const res = await runnable("bob");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const items = res.json.agents as Item[];
    expect(idsOf(res.json)).toEqual(expect.arrayContaining([teamAgent, pinned, gallery]));
    expect(items.find((a) => a.id === pinned)).toMatchObject({
      name: "Pinned Bot",
      scope: "team",
      model: "smart",
    });
    expect(items.find((a) => a.id === teamAgent)).toMatchObject({
      description: "Ledger Bot does things",
      model: null,
    });
    expect(items.find((a) => a.id === gallery)?.scope).toBe("gallery");
    expect(items.find((a) => a.id === gallery)).toMatchObject({ galleryKey: "gallery-bot" });
    expect(items.find((a) => a.id === teamAgent)).not.toHaveProperty("galleryKey");
    expect(res.json.nextCursor).toBeNull();
  });

  it("is open to plain members and shows only their own personal agents", async () => {
    const carol = await runnable("carol");
    expect(carol.status).toBe(200);
    expect(idsOf(carol.json)).toContain(carolPersonal);
    expect(idsOf((await runnable("bob")).json)).not.toContain(carolPersonal);
  });

  it("hides suspended, archived, unpublished and other teams' agents", async () => {
    const found = idsOf((await runnable("carol")).json);
    for (const hidden of [suspendedTeam, suspendedPersonal, archived, draftOnly, marketingAgent]) {
      expect(found).not.toContain(hidden);
    }
    expect(idsOf((await runnable("dave")).json)).toContain(marketingAgent);
  });

  it("agrees with run start: every listed agent can start a thread, hidden ones cannot", async () => {
    const listed = idsOf((await runnable("carol")).json);
    for (const id of listed) {
      const t = await as.carol.post("/v1/threads", { agent_id: id });
      expect(t.status, `${id}: ${JSON.stringify(t.json)}`).toBe(201);
    }
    for (const id of [suspendedTeam, suspendedPersonal, archived]) {
      expect((await as.carol.post("/v1/threads", { agent_id: id })).status).toBeGreaterThanOrEqual(
        400,
      );
    }
  });

  it("reflects a team suspension of a gallery agent, and reactivation", async () => {
    // Gallery agents can be suspended for a team once the team's threads have used them.
    const t = await as.carol.post("/v1/threads", { agent_id: gallery });
    expect(t.status).toBe(201);
    const off = await as.alice.put(`/v1/agents/inventory/${gallery}/status`, {
      status: "suspended",
    });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(idsOf((await runnable("carol")).json)).not.toContain(gallery);
    await as.alice.put(`/v1/agents/inventory/${gallery}/status`, { status: "active" });
    expect(idsOf((await runnable("carol")).json)).toContain(gallery);
  });

  it("pages with limit and cursor, and rejects bad queries", async () => {
    const first = await runnable("bob", "?limit=2");
    expect(first.json.agents).toHaveLength(2);
    expect(first.json.nextCursor).toEqual(expect.any(String));
    const seen = [...idsOf(first.json)];
    let cursor = first.json.nextCursor as string | null;
    while (cursor) {
      const page = await runnable("bob", `?limit=2&cursor=${encodeURIComponent(cursor)}`);
      seen.push(...idsOf(page.json));
      cursor = page.json.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(idsOf((await runnable("bob")).json).sort());
    expect((await runnable("bob", "?limit=0")).status).toBe(400);
    expect((await runnable("bob", "?cursor=nope")).status).toBe(400);
    expect((await runnable("bob", "?foo=1")).status).toBe(400);
  });

  it("needs a signed-in team member", async () => {
    const anon = new TestBrowser(app, PUBLIC_URL);
    expect((await anon.get("/v1/agents/runnable")).status).toBe(401);
  });
});

describe("thread detail names the pinned agent (KOBE-122)", () => {
  it("returns the agent's name and its effective status, including after it is paused or archived", async () => {
    const agent = await published("bob", "team", "Detail Bot");
    const t = await as.bob.post("/v1/threads", { agent_id: agent });
    const id = t.json.thread_id as string;
    const status = async () => (await as.bob.get(`/v1/threads/${id}`)).json;
    expect(await status()).toMatchObject({ agent_name: "Detail Bot", agent_status: "active" });
    const off = await as.alice.put(`/v1/agents/inventory/${agent}/status`, { status: "suspended" });
    expect(off.status).toBe(200);
    expect(await status()).toMatchObject({ agent_name: "Detail Bot", agent_status: "suspended" });
    await as.alice.put(`/v1/agents/inventory/${agent}/status`, { status: "active" });
    expect((await as.bob.request("DELETE", `/v1/agents/${agent}`)).status).toBeLessThan(300);
    expect(await status()).toMatchObject({ agent_name: "Detail Bot", agent_status: "archived" });
    const plain = await as.bob.post("/v1/threads", {});
    expect((await as.bob.get(`/v1/threads/${plain.json.thread_id}`)).json).toMatchObject({
      agent_name: null,
      agent_status: null,
    });
  });

  it("does not show another member's thread", async () => {
    const t = await as.bob.post("/v1/threads", {});
    expect((await as.carol.get(`/v1/threads/${t.json.thread_id}`)).status).toBe(404);
  });
});

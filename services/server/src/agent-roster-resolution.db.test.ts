import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { serializeAgentFile } from "@kobe/agent-file";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { resolvePinnedAgent } from "./agents/versions.js";
import { sweepAgentSchedules } from "./agents/roster-schedules.js";
import { pauseOwnerSchedulesInTx } from "./schedules/offboard.js";
import { createApp } from "./app.js";
import { seedGalleryAgents } from "./gallery/seed.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { waitForAppSessionsToClose } from "./testing/app-sessions.js";
import { TestBrowser } from "./testing/browser.js";
import { MemoryMailer } from "./testing/mailer.js";

/**
 * Roster-driven resolution (KOBE-567, spec agents-roster AR5, AR9-AR11, §6.2): other members run
 * an assigned agent at the entry's version (latest or the pin), threads keep their pins, owner
 * eligibility (Unavailable), and schedules that pause and resume with the roster. Two members, two
 * teams. Own throwaway database.
 */
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";
const ANY = { "if-match": "*" };

type Person = "sam" | "alice" | "bob" | "carol" | "dave";
// Finance: alice team_admin, bob builder, carol member, sam member (and site admin).
// Marketing: dave builder.
const PEOPLE: readonly Person[] = ["sam", "alice", "bob", "carol", "dave"];
const ids = {} as Record<Person, string>;
const as = {} as Record<Person, TestBrowser>;
const finance = randomUUID();
const marketing = randomUUID();

let database: TestDatabase;
let deps: ServerDeps;
let app: ReturnType<typeof createApp>;

async function sql<T extends pg.QueryResultRow>(text: string, args: unknown[] = []) {
  const admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  try {
    return (await admin.query<T>(text, args)).rows;
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  deps = createServerDeps({
    databaseUrl: database.appUrl,
    publicUrl: PUBLIC_URL,
    authSecret: "t".repeat(48),
    setupToken: "setup-token-for-resolution-tests",
    trustedProxies: ["127.0.0.1/32"],
    mailer: new MemoryMailer(),
  });
  app = createApp(deps);
  for (const who of PEOPLE) {
    const user = await deps.createUserWithPassword(
      { email: `${who}@resolve.test`, name: who, password: PASSWORD },
      who === "sam" ? { siteRole: "admin" } : {},
    );
    ids[who] = user.id;
  }
  await sql(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'finance', 'Finance'), ($2, 'marketing', 'Marketing')`,
    [finance, marketing],
  );
  const members: [string, Person, string][] = [
    [finance, "alice", "team_admin"],
    [finance, "bob", "builder"],
    [finance, "carol", "member"],
    [finance, "sam", "member"],
    [marketing, "dave", "builder"],
  ];
  for (const [team, who, role] of members) {
    await sql(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      team,
      ids[who],
      role,
    ]);
  }
  for (const who of PEOPLE) {
    const b = new TestBrowser(app, PUBLIC_URL);
    const res = await b.post("/api/auth/sign-in/email", {
      email: `${who}@resolve.test`,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    as[who] = b;
    const team = who === "dave" ? marketing : finance;
    const active = await b.put("/v1/me/teams/active", { teamId: team });
    expect(active.status, JSON.stringify(active.json)).toBe(200);
    b.team = team;
  }
});

afterAll(async () => {
  await deps?.close();
  if (database) {
    await waitForAppSessionsToClose(database.appRole);
    await database.drop();
  }
});

async function personal(who: Person, name: string): Promise<string> {
  const created = await as[who].post("/v1/agents", {
    scope: "personal",
    frontmatter: { name, description: `${name} helps` },
    prompt: `You are ${name}.`,
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  await publish(who, id);
  return id;
}

async function publish(who: Person, id: string, name?: string): Promise<void> {
  if (name !== undefined) {
    const res = await as[who].request(
      "PUT",
      `/v1/agents/${id}`,
      { frontmatter: { name }, prompt: `You are ${name}.` },
      ANY,
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  }
  const pub = await as[who].request("POST", `/v1/agents/${id}/publish`, {}, ANY);
  expect(pub.status, JSON.stringify(pub.json)).toBe(201);
}

const assign = async (who: Person, id: string, target: "team" | "site") => {
  const res = await as[who].post(`/v1/agents/${id}/assignments`, { target });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
};
/** The owner proposes to the site and a site admin approves (AR6). */
const toSite = async (owner: Person, id: string) => {
  const res = await as[owner].post(`/v1/agents/${id}/assignments`, { target: "site" });
  expect(res.status, JSON.stringify(res.json)).toBe(202);
  await sitePut("sam", id, { state: "active" });
};
const teamPut = async (who: Person, id: string, body: object) => {
  const res = await as[who].put(`/v1/team/agent-roster/${id}`, body);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
};
const sitePut = async (who: Person, id: string, body: object) => {
  const res = await as[who].put(`/v1/site/agent-roster/${id}`, body);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
};

interface Runnable {
  id: string;
  name: string;
  currentVersion: number;
}
async function runnable(who: Person): Promise<Runnable[]> {
  const res = await as[who].get("/v1/agents/runnable?limit=200");
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.agents as Runnable[];
}
const runnableOf = async (who: Person, id: string) =>
  (await runnable(who)).find((a) => a.id === id);

/** Starts a thread with the agent; the pinned version, or the error status. */
async function startThread(who: Person, agentId: string) {
  const res = await as[who].post("/v1/threads", { agent_id: agentId });
  if (res.status !== 201) return { status: res.status, threadId: null, version: null };
  const threadId = res.json.thread_id as string;
  const [row] = await sql<{ agent_version: number }>(
    `SELECT agent_version FROM threads WHERE id = $1`,
    [threadId],
  );
  return { status: 201, threadId, version: row?.agent_version ?? null };
}

/** What a run of the thread resolves (KOBE-47 seam), as its owner. */
async function runResolves(teamId: string, owner: Person, agentId: string, version: number) {
  return withTeam(deps.database.db, teamId, (tx) =>
    resolvePinnedAgent(
      tx,
      { teamId, userId: ids[owner] },
      { agentScope: "personal", agentId, agentVersion: version },
    ),
  );
}

interface RosterRow {
  agentId: string;
  status: string;
  unavailableReason?: string;
  versionInEffect: number | null;
}
async function roster(who: Person, tab: "team" | "site"): Promise<RosterRow[]> {
  const res = await as[who].get(`/v1/agents/roster?tab=${tab}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.rows as RosterRow[];
}

describe("assigned agents run at the entry's version (AR5, AR9, §6.2, ac-1)", () => {
  it("another member runs an assigned agent at latest, then at the pin; threads keep their pins", async () => {
    const agent = await personal("bob", "Ledger One");
    // Not on any roster: someone else's personal agent is invisible.
    expect(await runnableOf("carol", agent)).toBeUndefined();
    expect((await startThread("carol", agent)).status).toBe(404);

    await assign("bob", agent, "team");
    expect(await runnableOf("carol", agent)).toMatchObject({
      name: "Ledger One",
      currentVersion: 1,
    });
    // The owner's publish reaches the team at once (latest)...
    await publish("bob", agent, "Ledger Two");
    expect(await runnableOf("carol", agent)).toMatchObject({
      name: "Ledger Two",
      currentVersion: 2,
    });
    const atLatest = await startThread("carol", agent);
    expect(atLatest).toMatchObject({ status: 201, version: 2 });
    // ...the owner's unpublished draft never does.
    const draft = await as.bob.request(
      "PUT",
      `/v1/agents/${agent}`,
      { frontmatter: { name: "Secret Draft" }, prompt: "draft" },
      ANY,
    );
    expect(draft.status).toBe(200);
    expect((await runnableOf("carol", agent))?.name).toBe("Ledger Two");

    // A team admin pins v1: runnable and new threads take the pin, behind latest.
    await teamPut("alice", agent, { state: "active", versionRule: 1 });
    expect(await runnableOf("carol", agent)).toMatchObject({
      name: "Ledger One",
      currentVersion: 1,
    });
    const atPin = await startThread("carol", agent);
    expect(atPin).toMatchObject({ status: 201, version: 1 });
    // Switching a thread is limited to the version in effect.
    const sw = await as.carol.post(`/v1/threads/${atPin.threadId}/agent`, {
      agent_id: agent,
      version: 2,
    });
    expect(sw.status).not.toBe(200);
    // The earlier thread still runs v2 (D19).
    expect(await runResolves(finance, "carol", agent, 2)).toMatchObject({
      ok: true,
      version: { version: 2 },
    });

    // Removed from the roster: no longer runnable or pinnable; both threads keep running.
    await teamPut("alice", agent, { state: "removed" });
    expect(await runnableOf("carol", agent)).toBeUndefined();
    expect((await startThread("carol", agent)).status).toBe(404);
    expect(await runResolves(finance, "carol", agent, 2)).toMatchObject({ ok: true });
    expect(await runResolves(finance, "carol", agent, 1)).toMatchObject({ ok: true });
    // Another team never sees Finance's roster.
    expect(await runnableOf("dave", agent)).toBeUndefined();
    expect(await runResolves(marketing, "dave", agent, 1)).toMatchObject({
      ok: false,
      error: "agent_not_found",
    });
  });

  it("a site entry runs in every team at its version; suspended site-wide or here it runs nowhere", async () => {
    const agent = await personal("bob", "Site Helper");
    await toSite("bob", agent);
    expect(await runnableOf("dave", agent)).toMatchObject({ currentVersion: 1 });
    expect(await runnableOf("carol", agent)).toMatchObject({ currentVersion: 1 });
    expect((await startThread("dave", agent)).version).toBe(1);

    await sitePut("sam", agent, { state: "suspended" });
    expect(await runnableOf("dave", agent)).toBeUndefined();
    expect((await startThread("dave", agent)).status).toBe(409);
    expect(await runResolves(marketing, "dave", agent, 1)).toMatchObject({
      ok: false,
      error: "agent_suspended",
    });
    await sitePut("sam", agent, { state: "active" });
    expect(await runnableOf("dave", agent)).toBeDefined();

    // Site-wide suspension wins over an active team entry too (§6.5).
    await assign("bob", agent, "team");
    await sitePut("sam", agent, { state: "suspended" });
    expect(await runnableOf("carol", agent)).toBeUndefined();
    expect((await startThread("carol", agent)).status).toBe(409);
    expect(await runResolves(finance, "carol", agent, 1)).toMatchObject({
      ok: false,
      error: "agent_suspended",
    });
    await sitePut("sam", agent, { state: "active" });
    expect(await runnableOf("carol", agent)).toBeDefined();

    // A team's own suspension ("Suspended here") applies only there.
    await teamPut("alice", agent, { state: "suspended" });
    expect(await runnableOf("carol", agent)).toBeUndefined();
    expect(await runnableOf("dave", agent)).toBeDefined();
    await teamPut("alice", agent, { state: "active" });
    expect(await runnableOf("carol", agent)).toBeDefined();
  });

  it("a bound agent is runnable through its own team's roster only (AR8)", async () => {
    const agent = await personal("bob", "Bound Helper");
    await sql(`UPDATE site_agents SET bound_team_id = $1 WHERE id = $2`, [finance, agent]);
    await assign("bob", agent, "team");
    expect(await runnableOf("carol", agent)).toBeDefined();
    expect(await runnableOf("bob", agent)).toBeDefined();
    // Bob in another team does not take his bound agent along.
    await sql(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [
      marketing,
      ids.bob,
    ]);
    expect((await as.bob.put("/v1/me/teams/active", { teamId: marketing })).status).toBe(200);
    as.bob.team = marketing;
    try {
      expect(await runnableOf("bob", agent)).toBeUndefined();
    } finally {
      expect((await as.bob.put("/v1/me/teams/active", { teamId: finance })).status).toBe(200);
      as.bob.team = finance;
    }
    await sql(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [marketing, ids.bob]);
  });
});

describe("owner eligibility (AR10, ac-2)", () => {
  it("owner left the team: Unavailable, not runnable, shown with the reason to team admins only", async () => {
    const agent = await personal("bob", "Leaver Bot");
    await assign("bob", agent, "team");
    const thread = await startThread("carol", agent);
    expect(thread.version).toBe(1);
    await sql(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [finance, ids.bob]);
    try {
      expect(await runnableOf("carol", agent)).toBeUndefined();
      expect((await startThread("carol", agent)).status).toBe(409);
      const admin = (await roster("alice", "team")).find((r) => r.agentId === agent);
      expect(admin).toMatchObject({ status: "unavailable", unavailableReason: "owner_left" });
      expect((await roster("carol", "team")).map((r) => r.agentId)).not.toContain(agent);
      // The thread keeps its pin and stays readable (and runnable: D19).
      expect(await runResolves(finance, "carol", agent, 1)).toMatchObject({ ok: true });
    } finally {
      await sql(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'builder')`, [
        finance,
        ids.bob,
      ]);
    }
    expect(await runnableOf("carol", agent)).toBeDefined();
    const back = (await roster("carol", "team")).find((r) => r.agentId === agent);
    expect(back?.status).toBe("active");
  });

  it("site entry whose owner is deactivated: Unavailable for every team, reason for site admins", async () => {
    const agent = await personal("dave", "Deactivated Bot");
    await toSite("dave", agent);
    expect(await runnableOf("carol", agent)).toBeDefined();
    await sql(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [ids.dave]);
    try {
      expect(await runnableOf("carol", agent)).toBeUndefined();
      const row = (await roster("sam", "site")).find((r) => r.agentId === agent);
      expect(row).toMatchObject({ status: "unavailable", unavailableReason: "owner_deactivated" });
      expect((await roster("carol", "site")).map((r) => r.agentId)).not.toContain(agent);
    } finally {
      await sql(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [ids.dave]);
    }
    expect(await runnableOf("carol", agent)).toBeDefined();
  });
});

describe("schedules follow the roster (AR11, ac-3)", () => {
  async function schedule(who: Person, agentId: string): Promise<string> {
    const res = await as[who].post("/v1/schedules", {
      agent_id: agentId,
      prompt: "Summarise yesterday's ledger.",
      recurrence: { kind: "daily", at: "09:00" },
      tz: "Europe/Berlin",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json.schedule_id as string;
  }
  async function state(id: string) {
    const [row] = await sql<{ active: boolean; paused_by: string | null; due: boolean }>(
      `SELECT active, paused_by, next_due_at IS NOT NULL AS due FROM schedules WHERE id = $1`,
      [id],
    );
    return row;
  }
  const notices = (id: string) =>
    sql<{ user_id: string; paused_by: string }>(
      `SELECT user_id, paused_by FROM notifications WHERE kind = 'schedule.paused' AND schedule_id = $1`,
      [id],
    );
  const audits = (id: string) =>
    sql<{ action: string; by: string }>(
      `SELECT action, target->>'by' AS by FROM audit_log
        WHERE action IN ('schedule.activated', 'schedule.deactivated') AND target->>'scheduleId' = $1
        ORDER BY seq`,
      [id],
    );

  it("pauses on removal with agent_unavailable, tells the owner, and resumes on re-assignment", async () => {
    const agent = await personal("bob", "Scheduled Bot");
    await assign("bob", agent, "team");
    const id = await schedule("carol", agent);
    // Bob's own schedule of his own agent is never touched by his roster.
    const own = await schedule("bob", agent);

    await teamPut("alice", agent, { state: "removed" });
    expect(await state(id)).toEqual({ active: false, paused_by: "agent_unavailable", due: false });
    expect(await state(own)).toMatchObject({ active: true });
    expect(await notices(id)).toEqual([{ user_id: ids.carol, paused_by: "agent_unavailable" }]);
    // The owner can't resume it while the agent is unavailable.
    const early = await as.carol.post(`/v1/schedules/${id}/resume`);
    expect(early.status).toBe(422);
    expect(early.json.code).toBe("agent_not_runnable");
    expect((await as.carol.get(`/v1/schedules/${id}`)).json.paused_by).toBe("agent_unavailable");

    await assign("bob", agent, "team");
    expect(await state(id)).toEqual({ active: true, paused_by: null, due: true });
    expect(await audits(id)).toEqual([
      { action: "schedule.deactivated", by: "agent_unavailable" },
      { action: "schedule.activated", by: "agent_available" },
    ]);
  });

  it("pauses on suspension here and site-wide, and resumes when lifted", async () => {
    const agent = await personal("bob", "Suspended Bot");
    await toSite("bob", agent);
    const finance1 = await schedule("carol", agent);
    const marketing1 = await schedule("dave", agent);

    await teamPut("alice", agent, { state: "suspended" });
    expect(await state(finance1)).toMatchObject({ active: false, paused_by: "agent_unavailable" });
    expect(await state(marketing1)).toMatchObject({ active: true });
    await teamPut("alice", agent, { state: "active" });
    expect(await state(finance1)).toMatchObject({ active: true, paused_by: null });

    await sitePut("sam", agent, { state: "suspended" });
    expect(await state(finance1)).toMatchObject({ active: false, paused_by: "agent_unavailable" });
    expect(await state(marketing1)).toMatchObject({
      active: false,
      paused_by: "agent_unavailable",
    });
    await sitePut("sam", agent, { state: "active" });
    expect(await state(finance1)).toMatchObject({ active: true });
    expect(await state(marketing1)).toMatchObject({ active: true });
  });

  it("pauses on a gallery agent's suspension here and resumes when lifted (AR11)", async () => {
    const [seeded] = await seedGalleryAgents(deps.database.db, [
      {
        key: "resolution-gallery",
        generation: 1,
        file: serializeAgentFile({ frontmatter: { name: "Gallery Sched" }, prompt: "Hi." }),
      },
    ]);
    const gallery = seeded?.agentId ?? "";
    const id = await schedule("carol", gallery);
    await teamPut("alice", gallery, { state: "suspended" });
    expect(await state(id)).toMatchObject({ active: false, paused_by: "agent_unavailable" });
    await teamPut("alice", gallery, { state: "active" });
    expect(await state(id)).toMatchObject({ active: true, paused_by: null });
  });

  it("never resumes the schedule of an owner who is deactivated, even when the agent is back", async () => {
    const agent = await personal("bob", "Guard Bot");
    await assign("bob", agent, "team");
    const id = await schedule("carol", agent);
    await teamPut("alice", agent, { state: "removed" });
    expect(await state(id)).toMatchObject({ paused_by: "agent_unavailable" });
    // Deactivated without the lifecycle hook: only the sync's owner check stands in the way.
    await sql(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [ids.carol]);
    try {
      await assign("bob", agent, "team");
      await sweepAgentSchedules(deps.database.db, finance);
      expect(await state(id)).toMatchObject({ active: false, paused_by: "agent_unavailable" });
    } finally {
      await sql(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [ids.carol]);
    }
  });

  it("owner leaves: paused at removal, resumed by the tick once back; a gone schedule owner is never resumed", async () => {
    const agent = await personal("bob", "Membership Bot");
    await assign("bob", agent, "team");
    const id = await schedule("carol", agent);

    const removed = await as.alice.request("DELETE", `/v1/team/members/${ids.bob}`);
    expect(removed.status, JSON.stringify(removed.json)).toBeLessThan(300);
    expect(await state(id)).toMatchObject({ active: false, paused_by: "agent_unavailable" });
    await sql(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'builder')`, [
      finance,
      ids.bob,
    ]);
    await sweepAgentSchedules(deps.database.db, finance);
    expect(await state(id)).toMatchObject({ active: true, paused_by: null });

    // Carol (the schedule's owner) is deactivated while it is agent-paused: it becomes
    // `deactivation`, and the agent coming back does not resume it.
    await teamPut("alice", agent, { state: "removed" });
    expect(await state(id)).toMatchObject({ paused_by: "agent_unavailable" });
    await withTeam(deps.database.db, finance, (tx) =>
      pauseOwnerSchedulesInTx(tx, finance, ids.carol, "deactivation"),
    );
    expect(await state(id)).toMatchObject({ active: false, paused_by: "deactivation" });
    await assign("bob", agent, "team");
    await sweepAgentSchedules(deps.database.db, finance);
    expect(await state(id)).toMatchObject({ active: false, paused_by: "deactivation" });
  });
});

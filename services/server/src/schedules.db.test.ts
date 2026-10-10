import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_ACTIVE_SCHEDULES_PER_USER, scheduleResponseSchema } from "@kobe/protocol";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { createApp } from "./app.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { waitForAppSessionsToClose } from "./testing/app-sessions.js";
import { TestBrowser } from "./testing/browser.js";
import { MemoryMailer } from "./testing/mailer.js";

/** Schedules API (KOBE-173): CRUD under RLS, the per-user cap across teams, next_due_at. */
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";
const ANY = { "if-match": "*" };

type Person = "admin" | "bob" | "carol" | "erin" | "dave";
// Finance: admin team_admin, bob builder, carol member, erin builder. Marketing: bob, dave, erin.
const PEOPLE: readonly Person[] = ["admin", "bob", "carol", "erin", "dave"];
const ids = {} as Record<Person, string>;
const as = {} as Record<Person, TestBrowser>;
const finance = randomUUID();
const marketing = randomUUID();

let database: TestDatabase;
let deps: ServerDeps;
let app: ReturnType<typeof createApp>;
let adminPg: pg.Client;

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
    const user = await deps.createUserWithPassword(
      { email: `${who}@sched.test`, name: who, password: PASSWORD },
      {},
    );
    ids[who] = user.id;
  }
  adminPg = new pg.Client({ connectionString: database.adminUrl });
  await adminPg.connect();
  await adminPg.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'finance', 'Finance'), ($2, 'marketing', 'Marketing')`,
    [finance, marketing],
  );
  const members: [string, Person, string][] = [
    [finance, "admin", "team_admin"],
    [finance, "bob", "builder"],
    [finance, "carol", "member"],
    [finance, "erin", "builder"],
    [marketing, "bob", "builder"],
    [marketing, "dave", "builder"],
    [marketing, "erin", "builder"],
  ];
  for (const [team, who, role] of members) {
    await adminPg.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      team,
      ids[who],
      role,
    ]);
  }
  for (const who of PEOPLE) {
    const b = new TestBrowser(app, PUBLIC_URL);
    const res = await b.post("/api/auth/sign-in/email", {
      email: `${who}@sched.test`,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    as[who] = b;
  }
  for (const who of ["admin", "bob", "carol", "erin"] as const) await activate(who, finance);
  await activate("dave", marketing);
});

afterAll(async () => {
  await adminPg?.end();
  await deps?.close();
  if (database) {
    await waitForAppSessionsToClose(database.appRole);
    await database.drop();
  }
});

async function published(who: Person, name: string): Promise<string> {
  const created = await as[who].post("/v1/agents", {
    scope: "team",
    frontmatter: { name, description: `${name} does things` },
    prompt: `You are ${name}.`,
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  const pub = await as[who].request("POST", `/v1/agents/${id}/publish`, {}, ANY);
  expect(pub.status, JSON.stringify(pub.json)).toBe(201);
  return id;
}

let financeAgent: string;
let marketingAgent: string;
let draftOnly: string;
beforeAll(async () => {
  financeAgent = await published("bob", "Finance Bot");
  marketingAgent = await published("dave", "Marketing Bot");
  const draft = await as.bob.post("/v1/agents", {
    scope: "team",
    frontmatter: { name: "Unpublished" },
    prompt: "x",
  });
  draftOnly = draft.json.agent.id as string;
});

const body = (agentId: string, extra: Record<string, unknown> = {}) => ({
  agent_id: agentId,
  prompt: "Summarise yesterday's ledger.",
  recurrence: { kind: "daily", at: "09:00" },
  tz: "Europe/Berlin",
  ...extra,
});

async function create(who: Person, agentId: string, extra: Record<string, unknown> = {}) {
  return as[who].post("/v1/schedules", body(agentId, extra));
}

async function activeCount(userId: string): Promise<number> {
  const r = await adminPg.query(
    `SELECT count(*)::int AS n FROM schedules WHERE user_id = $1 AND active`,
    [userId],
  );
  return r.rows[0].n as number;
}

describe("CRUD (ac-1)", () => {
  it("creates, reads, lists, patches and deletes the owner's schedule", async () => {
    const res = await create("carol", financeAgent, { notify_email: true });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const made = scheduleResponseSchema.parse(res.json);
    expect(made).toMatchObject({
      team_id: finance,
      user_id: ids.carol,
      agent_id: financeAgent,
      active: true,
      notify_email: true,
      paused_by: null,
      last_run_id: null,
    });
    expect(made.next_due_at).not.toBeNull();
    expect(new Date(made.next_due_at as string).getTime()).toBeGreaterThan(Date.now());
    const row = await adminPg.query(`SELECT cron FROM schedules WHERE id = $1`, [made.schedule_id]);
    expect(row.rows[0].cron).toBe("0 9 * * *");

    const got = await as.carol.get(`/v1/schedules/${made.schedule_id}`);
    expect(got.status).toBe(200);
    expect(got.json.schedule_id).toBe(made.schedule_id);

    const list = await as.carol.get("/v1/schedules");
    expect(list.status).toBe(200);
    expect(list.json.schedules.map((s: { schedule_id: string }) => s.schedule_id)).toContain(
      made.schedule_id,
    );
    expect(list.json.active_count).toBeGreaterThanOrEqual(1);

    const patched = await as.carol.request("PATCH", `/v1/schedules/${made.schedule_id}`, {
      prompt: "New prompt",
      recurrence: { kind: "weekdays", at: "07:30" },
    });
    expect(patched.status, JSON.stringify(patched.json)).toBe(200);
    expect(patched.json.prompt).toBe("New prompt");
    expect(patched.json.next_due_at).not.toBe(made.next_due_at);
    expect(patched.json.updated_at >= made.updated_at).toBe(true);

    const del = await as.carol.request("DELETE", `/v1/schedules/${made.schedule_id}`);
    expect(del.status).toBe(204);
    expect((await as.carol.get(`/v1/schedules/${made.schedule_id}`)).status).toBe(404);
  });

  it("a timezone change recomputes next_due_at", async () => {
    const res = await create("carol", financeAgent, { tz: "UTC" });
    const id = res.json.schedule_id as string;
    const patched = await as.carol.request("PATCH", `/v1/schedules/${id}`, { tz: "Asia/Tokyo" });
    expect(patched.status).toBe(200);
    expect(patched.json.tz).toBe("Asia/Tokyo");
    expect(patched.json.next_due_at).not.toBe(res.json.next_due_at);
    // 09:00 Tokyo is 00:00 UTC.
    expect(new Date(patched.json.next_due_at).getUTCHours()).toBe(0);
    await as.carol.request("DELETE", `/v1/schedules/${id}`);
  });

  it("other users and other teams get the same 404 for every operation", async () => {
    const res = await create("carol", financeAgent);
    const id = res.json.schedule_id as string;
    const missing = randomUUID();
    const ops: [string, string, unknown?][] = [
      ["GET", ""],
      ["PATCH", "", { prompt: "x" }],
      ["DELETE", ""],
      ["POST", "/pause"],
      ["POST", "/resume"],
    ];
    for (const who of ["bob", "dave"] as const) {
      for (const [method, suffix, payload] of ops) {
        const other = await as[who].request(method, `/v1/schedules/${id}${suffix}`, payload);
        const none = await as[who].request(method, `/v1/schedules/${missing}${suffix}`, payload);
        expect([who, method, suffix, other.status]).toEqual([who, method, suffix, 404]);
        expect(other.json).toEqual(none.json);
      }
    }
    expect((await as.dave.get("/v1/schedules")).json.schedules).toEqual([]);
    expect((await as.bob.get("/v1/schedules")).json.schedules).toEqual([]);
    expect((await as.carol.get(`/v1/schedules/${id}`)).status).toBe(200);
    await as.carol.request("DELETE", `/v1/schedules/${id}`);
  });

  it("validation errors use the contract codes", async () => {
    const badRec = await create("carol", financeAgent, {
      recurrence: { kind: "cron", expr: "* * * * *" },
    });
    expect(badRec.status).toBe(422);
    expect(badRec.json.code).toBe("invalid_recurrence");
    const badTz = await create("carol", financeAgent, { tz: "+01:00" });
    expect(badTz.status).toBe(422);
    expect(badTz.json.code).toBe("invalid_timezone");
    for (const agent of [draftOnly, randomUUID(), marketingAgent]) {
      const res = await create("carol", agent);
      expect([agent, res.status, res.json.code]).toEqual([agent, 422, "agent_not_runnable"]);
    }
    const blank = await create("carol", financeAgent, { prompt: "   " });
    expect(blank.status).toBe(400);
    expect(blank.json.code).toBe("invalid_request");
    const extra = await as.carol.post("/v1/schedules", { ...body(financeAgent), user_id: ids.bob });
    expect(extra.status).toBe(400);
    expect((await as.carol.request("PATCH", `/v1/schedules/${randomUUID()}`, {})).status).toBe(400);
    expect((await as.carol.get("/v1/schedules/not-a-uuid")).status).toBe(400);
  });

  it("records audit events with ids only", async () => {
    const res = await create("carol", financeAgent, { prompt: "secret-ish prompt text" });
    const id = res.json.schedule_id as string;
    await as.carol.request("PATCH", `/v1/schedules/${id}`, { prompt: "other secret text" });
    await as.carol.post(`/v1/schedules/${id}/pause`);
    await as.carol.post(`/v1/schedules/${id}/resume`);
    await as.carol.request("DELETE", `/v1/schedules/${id}`);
    const log = await adminPg.query(
      `SELECT action, target::text AS target FROM audit_log WHERE action LIKE 'schedule.%' AND target->>'scheduleId' = $1 ORDER BY seq`,
      [id],
    );
    expect(log.rows.map((r) => r.action)).toEqual([
      "schedule.created",
      "schedule.updated",
      "schedule.deactivated",
      "schedule.activated",
      "schedule.deleted",
    ]);
    for (const r of log.rows) expect(r.target).not.toMatch(/secret/);
  });

  it("pause and resume; owner pause is not a team-admin pause", async () => {
    const res = await create("carol", financeAgent);
    const id = res.json.schedule_id as string;
    const paused = await as.carol.post(`/v1/schedules/${id}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.json).toMatchObject({ active: false, next_due_at: null, paused_by: null });
    const resumed = await as.carol.post(`/v1/schedules/${id}/resume`);
    expect(resumed.json.active).toBe(true);
    expect(resumed.json.next_due_at).not.toBeNull();
    await as.carol.request("DELETE", `/v1/schedules/${id}`);
  });

  it("team admins list the inventory and pause others; only an admin resumes that", async () => {
    const res = await create("carol", financeAgent);
    const id = res.json.schedule_id as string;
    expect((await as.carol.get("/v1/schedules?scope=team")).status).toBe(403);
    const inventory = await as.admin.get("/v1/schedules?scope=team");
    expect(inventory.status).toBe(200);
    expect(inventory.json.schedules.map((s: { schedule_id: string }) => s.schedule_id)).toContain(
      id,
    );
    // The admin cannot read or edit it through the owner routes (404), only pause/resume it.
    expect((await as.admin.get(`/v1/schedules/${id}`)).status).toBe(404);
    const paused = await as.admin.post(`/v1/schedules/${id}/pause`);
    expect(paused.status, JSON.stringify(paused.json)).toBe(200);
    expect(paused.json).toMatchObject({ active: false, paused_by: "team_admin" });
    expect((await as.carol.post(`/v1/schedules/${id}/resume`)).status).toBe(403);
    expect((await as.carol.request("PATCH", `/v1/schedules/${id}`, { active: true })).status).toBe(
      403,
    );
    const resumed = await as.admin.post(`/v1/schedules/${id}/resume`);
    expect(resumed.json).toMatchObject({ active: true, paused_by: null });
    await as.carol.request("DELETE", `/v1/schedules/${id}`);
  });
});

describe("team admin pause cannot be undone by the owner (review fix)", () => {
  it("owner PATCH active:false keeps paused_by; owner cannot resume; admin can", async () => {
    const res = await create("carol", financeAgent);
    const id = res.json.schedule_id as string;
    const paused = await as.admin.post(`/v1/schedules/${id}/pause`);
    expect(paused.json).toMatchObject({ active: false, paused_by: "team_admin" });
    const again = await as.carol.request("PATCH", `/v1/schedules/${id}`, { active: false });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json).toMatchObject({ active: false, paused_by: "team_admin" });
    expect((await as.carol.post(`/v1/schedules/${id}/resume`)).status).toBe(403);
    expect((await as.carol.request("PATCH", `/v1/schedules/${id}`, { active: true })).status).toBe(
      403,
    );
    expect((await as.carol.get(`/v1/schedules/${id}`)).json).toMatchObject({ active: false });
    const resumed = await as.admin.post(`/v1/schedules/${id}/resume`);
    expect(resumed.json).toMatchObject({ active: true, paused_by: null });
    await as.carol.request("DELETE", `/v1/schedules/${id}`);
  });
});

describe("cap of 10 active schedules per user across teams (ac-2)", () => {
  it("counts every team, refuses the 11th and frees a slot on deactivation", async () => {
    const made: { team: Person; id: string }[] = [];
    // erin is in both teams; dave's marketing agent is team-scoped, so each team needs its own agent.
    for (let i = 0; i < MAX_ACTIVE_SCHEDULES_PER_USER; i++) {
      const inMarketing = i % 2 === 1;
      const browser = as.erin;
      await activate("erin", inMarketing ? marketing : finance);
      const res = await browser.post(
        "/v1/schedules",
        body(inMarketing ? marketingAgent : financeAgent),
      );
      expect(res.status, `${i}: ${JSON.stringify(res.json)}`).toBe(201);
      made.push({ team: "erin", id: res.json.schedule_id });
    }
    expect(await activeCount(ids.erin)).toBe(10);
    for (const team of [finance, marketing]) {
      await activate("erin", team);
      const over = await as.erin.post(
        "/v1/schedules",
        body(team === finance ? financeAgent : marketingAgent),
      );
      expect(over.status).toBe(409);
      expect(over.json).toMatchObject({
        code: "schedule_cap_reached",
        active_count: 10,
        limit: 10,
      });
      expect((await as.erin.get("/v1/schedules")).json.active_count).toBe(10);
    }
    // An inactive schedule is allowed past the cap; activating it is not.
    await activate("erin", finance);
    const inactive = await as.erin.post("/v1/schedules", body(financeAgent, { active: false }));
    expect(inactive.status, JSON.stringify(inactive.json)).toBe(201);
    expect(inactive.json).toMatchObject({ active: false, next_due_at: null });
    const resumeAtCap = await as.erin.post(`/v1/schedules/${inactive.json.schedule_id}/resume`);
    expect(resumeAtCap.status).toBe(409);
    const patchAtCap = await as.erin.request(
      "PATCH",
      `/v1/schedules/${inactive.json.schedule_id}`,
      { active: true },
    );
    expect(patchAtCap.status).toBe(409);
    // Deactivating one (in the other team) frees a slot.
    const [first] = made;
    await activate("erin", finance);
    const pause = await as.erin.post(`/v1/schedules/${first?.id}/pause`);
    expect(pause.status).toBe(200);
    const resume = await as.erin.post(`/v1/schedules/${inactive.json.schedule_id}/resume`);
    expect(resume.status, JSON.stringify(resume.json)).toBe(200);
    expect(await activeCount(ids.erin)).toBe(10);
  });

  it("an admin resuming at the owner's cap learns the code, not the count", async () => {
    const owner = "dave";
    await activate(owner, marketing);
    const made: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_SCHEDULES_PER_USER; i++) {
      const r = await as.dave.post("/v1/schedules", body(marketingAgent));
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      made.push(r.json.schedule_id);
    }
    const extra = await as.dave.post("/v1/schedules", body(marketingAgent, { active: false }));
    expect(extra.status).toBe(201);
    // Dave has no admin here; make alice-like admin via erin in marketing? Use SQL role change.
    await adminPg.query(
      `UPDATE team_members SET role = 'team_admin' WHERE team_id = $1 AND user_id = $2`,
      [marketing, ids.erin],
    );
    await adminPg.query(`UPDATE schedules SET paused_by = 'team_admin' WHERE id = $1`, [
      extra.json.schedule_id,
    ]);
    await activate("erin", marketing);
    const res = await as.erin.post(`/v1/schedules/${extra.json.schedule_id}/resume`);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("schedule_cap_reached");
    expect(res.json).not.toHaveProperty("active_count");
    expect(res.json).not.toHaveProperty("limit");
    await adminPg.query(
      `UPDATE team_members SET role = 'builder' WHERE team_id = $1 AND user_id = $2`,
      [marketing, ids.erin],
    );
    await adminPg.query(`DELETE FROM schedules WHERE user_id = $1`, [ids.dave]);
  });

  it("12 concurrent creates across two teams leave at most 10 active", async () => {
    // bob is in both teams, so concurrent requests carry different team headers.
    const sessions = await Promise.all(
      [finance, marketing].map(async (team) => {
        const b = new TestBrowser(app, PUBLIC_URL);
        await b.post("/api/auth/sign-in/email", { email: "bob@sched.test", password: PASSWORD });
        await activate("bob", team).catch(() => undefined);
        b.team = team;
        await b.put("/v1/me/teams/active", { teamId: team });
        return b;
      }),
    );
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (sessions[i % 2] as TestBrowser).post(
          "/v1/schedules",
          body(i % 2 === 0 ? financeAgent : marketingAgent),
        ),
      ),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201).length).toBe(10);
    expect(statuses.filter((s) => s === 409).length).toBe(2);
    expect(await activeCount(ids.bob)).toBe(10);
  });
});

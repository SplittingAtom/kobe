import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { createApp } from "./app.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { cancelScheduledRuns } from "./runs/cancel-scheduled.js";
import { SchedulerRunner } from "./scheduler/runner.js";
import { waitForAppSessionsToClose } from "./testing/app-sessions.js";
import { TestBrowser } from "./testing/browser.js";
import { MemoryMailer } from "./testing/mailer.js";

/**
 * Schedule lifecycle and governance (KOBE-180, D7/D19/D32): deactivation and team removal stop a
 * user's schedules and cancel their in-flight scheduled runs; team admins pause and resume with
 * an audit trail; the agent inventory lists schedules, and a suspended agent does not fire.
 */
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";
const ANY = { "if-match": "*" };
const GRACE_MS = 60 * 60_000;
// Every schedule here is daily at 09:00 UTC; the runner's clock sits 20 minutes after an occurrence.
const DUE = new Date("2026-10-10T09:00:00Z");
const NOW = new Date("2026-10-10T09:20:00Z");
const NEXT_DAY = new Date("2026-10-11T09:20:00Z");

type Person =
  "admin" | "madmin" | "bob" | "erin" | "carol" | "dave" | "fred" | "gina" | "hank" | "ivy";
// Finance: admin team_admin; bob, erin, carol, dave builders. Marketing: madmin team_admin; bob, erin.
const PEOPLE: readonly Person[] = [
  "admin",
  "madmin",
  "bob",
  "erin",
  "carol",
  "dave",
  "fred",
  "gina",
  "hank",
  "ivy",
];
const ids = {} as Record<Person, string>;
const as = {} as Record<Person, TestBrowser>;
const finance = randomUUID();
const marketing = randomUUID();

let database: TestDatabase;
let deps: ServerDeps;
let app: ReturnType<typeof createApp>;
let adminPg: pg.Client;
let financeAgent: string;
let marketingAgent: string;
let siteOwner: TestBrowser;

async function signIn(who: Person, teamId: string): Promise<void> {
  const b = new TestBrowser(app, PUBLIC_URL);
  const res = await b.post("/api/auth/sign-in/email", {
    email: `${who}@gov.test`,
    password: PASSWORD,
  });
  expect(res.status).toBe(200);
  as[who] = b;
  await switchTo(who, teamId);
}

async function switchTo(who: Person, teamId: string): Promise<void> {
  const res = await as[who].put("/v1/me/teams/active", { teamId });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  as[who].team = teamId;
}

async function published(who: Person, scope: "team" | "personal", name: string): Promise<string> {
  const created = await as[who].post("/v1/agents", {
    scope,
    frontmatter: { name, description: `${name} does things` },
    prompt: `You are ${name}.`,
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  const pub = await as[who].request("POST", `/v1/agents/${id}/publish`, {}, ANY);
  expect(pub.status, JSON.stringify(pub.json)).toBe(201);
  return id;
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
    runs: { sweep: false },
  });
  app = createApp(deps);
  for (const who of PEOPLE) {
    const user = await deps.createUserWithPassword(
      { email: `${who}@gov.test`, name: who, password: PASSWORD },
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
    [finance, "erin", "builder"],
    [finance, "carol", "builder"],
    [finance, "dave", "builder"],
    [finance, "fred", "builder"],
    [finance, "gina", "builder"],
    [finance, "hank", "builder"],
    [finance, "ivy", "builder"],
    [marketing, "madmin", "team_admin"],
    [marketing, "bob", "builder"],
    [marketing, "erin", "builder"],
  ];
  for (const [team, who, role] of members) {
    await adminPg.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      team,
      ids[who],
      role,
    ]);
  }
  for (const who of PEOPLE) await signIn(who, who === "madmin" ? marketing : finance);
  await deps.createUserWithPassword(
    { email: "owner@gov.test", name: "owner", password: PASSWORD },
    { siteRole: "owner" },
  );
  siteOwner = new TestBrowser(app, PUBLIC_URL);
  const owner = await siteOwner.post("/api/auth/sign-in/email", {
    email: "owner@gov.test",
    password: PASSWORD,
  });
  expect(owner.status).toBe(200);
  financeAgent = await published("carol", "team", "Ledger Bot");
  await switchTo("erin", marketing);
  marketingAgent = await published("erin", "team", "Campaign Bot");
  await switchTo("erin", finance);
});

afterAll(async () => {
  deps?.runs.close();
  await adminPg?.end();
  await deps?.close();
  if (database) {
    await waitForAppSessionsToClose(database.appRole);
    await database.drop();
  }
});

async function rows<T extends pg.QueryResultRow>(text: string, args: unknown[] = []) {
  return (await adminPg.query<T>(text, args)).rows;
}

/** Creates an active daily 09:00 UTC schedule as `who` in their active team; returns its id. */
async function schedule(who: Person, agentId: string): Promise<string> {
  const res = await as[who].post("/v1/schedules", {
    agent_id: agentId,
    prompt: "Summarise yesterday's ledger.",
    recurrence: { kind: "daily", at: "09:00" },
    tz: "UTC",
    active: true,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.schedule_id as string;
}

const runner = (now: Date) =>
  new SchedulerRunner({ db: deps.database.db, runs: deps.runs, now: () => now, graceMs: GRACE_MS });

/** Makes the schedules due at `DUE` and fires them; returns each schedule's scheduled run. */
async function fire(scheduleIds: readonly string[]): Promise<string[]> {
  await adminPg.query(`UPDATE schedules SET next_due_at = $1 WHERE id = ANY($2)`, [
    DUE,
    scheduleIds,
  ]);
  await runner(NOW).tick();
  const runIds: string[] = [];
  for (const id of scheduleIds) {
    const [run] = await rows<{ id: string }>(
      `SELECT r.id FROM runs r JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
        WHERE t.schedule_id = $1 AND r.trigger = 'schedule'`,
      [id],
    );
    expect(run, `scheduled run of ${id}`).toBeDefined();
    runIds.push(run?.id as string);
  }
  return runIds;
}

/** A fired run is `running` (its start waits for a sandbox that never comes); this one waits queued. */
async function requeue(runId: string): Promise<void> {
  await adminPg.query(`UPDATE runs SET status = 'queued' WHERE id = $1`, [runId]);
}

const runStatus = async (runId: string) =>
  (await rows<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [runId]))[0]?.status;

const scheduleRow = async (id: string) =>
  (
    await rows<{ active: boolean; paused_by: string | null; next_due_at: Date | null }>(
      `SELECT active, paused_by, next_due_at FROM schedules WHERE id = $1`,
      [id],
    )
  )[0];

const threadCount = async (id: string) =>
  (
    await rows<{ n: number }>(`SELECT count(*)::int AS n FROM threads WHERE schedule_id = $1`, [id])
  )[0]?.n;

const skipReasons = async (id: string) =>
  (
    await rows<{ reason: string }>(
      `SELECT ref->>'reason' AS reason FROM events
        WHERE kind = 'schedule.skip' AND ref->>'schedule_id' = $1 ORDER BY created_at`,
      [id],
    )
  ).map((r) => r.reason);

const scheduleAudit = async (id: string) =>
  rows<{ action: string; actor_kind: string; by: string }>(
    `SELECT action, actor_kind::text AS actor_kind, target->>'by' AS by FROM audit_log
      WHERE action LIKE 'schedule.%activated' AND target->>'scheduleId' = $1 ORDER BY seq`,
    [id],
  );

const cancelAudit = async (runId: string) =>
  rows<{ actor_kind: string; reason: string }>(
    `SELECT actor_kind::text AS actor_kind, target->>'reason' AS reason FROM audit_log
      WHERE action = 'run.cancelled' AND target->>'runId' = $1`,
    [runId],
  );

describe("deactivation stops the user's schedules (ac-1)", () => {
  let inFinance: string;
  let inMarketing: string;
  let ownerPaused: string;
  let runs: string[];

  beforeAll(async () => {
    inFinance = await schedule("bob", financeAgent);
    ownerPaused = await schedule("bob", financeAgent);
    expect((await as.bob.post(`/v1/schedules/${ownerPaused}/pause`)).status).toBe(200);
    await switchTo("bob", marketing);
    inMarketing = await schedule("bob", marketingAgent);
    runs = await fire([inFinance, inMarketing]);
    expect(await runStatus(runs[0] as string)).toBe("running");
    await requeue(runs[1] as string);
    const res = await siteOwner.post(`/v1/site/users/${ids.bob}/deactivate`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.incompleteSteps).not.toContain("schedules");
  });

  it("pauses every team's active schedules (paused_by=deactivation) and audits it", async () => {
    for (const id of [inFinance, inMarketing]) {
      expect(await scheduleRow(id)).toEqual({
        active: false,
        paused_by: "deactivation",
        next_due_at: null,
      });
      expect(await scheduleAudit(id)).toContainEqual({
        action: "schedule.deactivated",
        actor_kind: "system",
        by: "deactivation",
      });
    }
    // An owner's own pause is left as it was.
    expect((await scheduleRow(ownerPaused))?.paused_by).toBeNull();
  });

  it("cancels the in-flight scheduled runs, running and queued", async () => {
    for (const runId of runs) {
      expect(await runStatus(runId)).toBe("cancelled");
      expect(await cancelAudit(runId)).toEqual([
        { actor_kind: "system", reason: "owner_deactivated" },
      ]);
    }
  });

  it("nothing fires afterwards, and no skip is recorded per occurrence", async () => {
    await runner(NEXT_DAY).tick();
    for (const id of [inFinance, inMarketing]) {
      expect(await threadCount(id)).toBe(1);
      expect(await skipReasons(id)).toEqual([]);
    }
  });

  it("reactivation keeps them paused until the owner resumes each one", async () => {
    expect((await siteOwner.post(`/v1/site/users/${ids.bob}/reactivate`)).status).toBe(200);
    expect((await scheduleRow(inFinance))?.paused_by).toBe("deactivation");
    // A team admin does not resume a schedule the owner's deactivation paused.
    expect((await as.admin.post(`/v1/schedules/${inFinance}/resume`)).status).toBe(404);
    await signIn("bob", finance);
    const resumed = await as.bob.post(`/v1/schedules/${inFinance}/resume`);
    expect(resumed.status, JSON.stringify(resumed.json)).toBe(200);
    expect(resumed.json).toMatchObject({ active: true, paused_by: null });
    expect((await scheduleRow(inMarketing))?.paused_by).toBe("deactivation");
  });
});

describe("removal from a team stops only that team's schedules (ac-1)", () => {
  it("pauses and cancels in the team left, leaves the other team alone", async () => {
    const here = await schedule("erin", financeAgent);
    await switchTo("erin", marketing);
    const there = await schedule("erin", marketingAgent);
    const [hereRun, thereRun] = await fire([here, there]);
    const removed = await as.admin.request("DELETE", `/v1/team/members/${ids.erin}`);
    expect(removed.status, JSON.stringify(removed.json)).toBe(204);
    expect(await scheduleRow(here)).toEqual({
      active: false,
      paused_by: "deactivation",
      next_due_at: null,
    });
    expect(await scheduleAudit(here)).toContainEqual({
      action: "schedule.deactivated",
      actor_kind: "system",
      by: "member_removed",
    });
    expect(await runStatus(hereRun as string)).toBe("cancelled");
    expect(await cancelAudit(hereRun as string)).toEqual([
      { actor_kind: "system", reason: "member_removed" },
    ]);
    expect((await scheduleRow(there))?.active).toBe(true);
    expect(await runStatus(thereRun as string)).toBe("running");
  });
});

describe("team admin governance (ac-2)", () => {
  it("lists, pauses and resumes any team schedule; the owner cannot override; audited", async () => {
    const id = await schedule("carol", financeAgent);
    const list = await as.admin.get("/v1/schedules?scope=team");
    expect(list.status).toBe(200);
    expect(list.json.schedules.map((s: { schedule_id: string }) => s.schedule_id)).toContain(id);
    const paused = await as.admin.post(`/v1/schedules/${id}/pause`);
    expect(paused.json).toMatchObject({ active: false, paused_by: "team_admin" });
    const owner = await as.carol.post(`/v1/schedules/${id}/resume`);
    expect(owner.status).toBe(403);
    expect(owner.json.code).toBe("paused_by_team_admin");
    expect((await as.carol.request("PATCH", `/v1/schedules/${id}`, { active: true })).status).toBe(
      403,
    );
    const resumed = await as.admin.post(`/v1/schedules/${id}/resume`);
    expect(resumed.json).toMatchObject({ active: true, paused_by: null });
    expect(await scheduleAudit(id)).toEqual([
      { action: "schedule.deactivated", actor_kind: "user", by: "team_admin" },
      { action: "schedule.activated", actor_kind: "user", by: "team_admin" },
    ]);
  });

  it("a team admin acts on their own team only", async () => {
    const id = await schedule("carol", financeAgent);
    const list = await as.madmin.get("/v1/schedules?scope=team");
    expect(list.json.schedules.map((s: { schedule_id: string }) => s.schedule_id)).not.toContain(
      id,
    );
    expect((await as.madmin.post(`/v1/schedules/${id}/pause`)).status).toBe(404);
    expect((await scheduleRow(id))?.active).toBe(true);
  });
});

type InventorySchedule = {
  scheduleId: string;
  ownerUserId: string;
  ownerName: string;
  status: string;
  pausedBy: string | null;
};
type InventoryItem = { id: string; status: string; schedules: InventorySchedule[] };

describe("inventory lists schedules; suspended agents do not fire (ac-3)", () => {
  it("shows each agent's schedules with owner and status, including a scheduled personal agent", async () => {
    const personal = await published("dave", "personal", "Dave Digest");
    const active = await schedule("dave", financeAgent);
    const paused = await schedule("dave", financeAgent);
    await as.admin.post(`/v1/schedules/${paused}/pause`);
    const own = await schedule("dave", personal);
    const inv = await as.admin.get("/v1/agents/inventory?limit=200");
    expect(inv.status, JSON.stringify(inv.json)).toBe(200);
    const items = inv.json.agents as InventoryItem[];
    const team = items.find((a) => a.id === financeAgent);
    expect(team?.schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scheduleId: active,
          ownerUserId: ids.dave,
          ownerName: "dave",
          status: "active",
          pausedBy: null,
        }),
        expect.objectContaining({ scheduleId: paused, status: "paused", pausedBy: "team_admin" }),
      ]),
    );
    // Only this team's schedules: marketing's agent is not here, nor its schedules.
    expect(items.some((a) => a.id === marketingAgent)).toBe(false);
    const mine = items.find((a) => a.id === personal);
    expect(mine?.schedules.map((s) => s.scheduleId)).toEqual([own]);
  });

  it("a personal agent the team suspends from the inventory does not fire", async () => {
    const personal = await published("dave", "personal", "Dave Nightly");
    const id = await schedule("dave", personal);
    const suspended = await as.admin.put(`/v1/agents/inventory/${personal}/status`, {
      status: "suspended",
    });
    expect(suspended.status, JSON.stringify(suspended.json)).toBe(200);
    await adminPg.query(`UPDATE schedules SET next_due_at = $1 WHERE id = $2`, [DUE, id]);
    await runner(NOW).tick();
    expect(await threadCount(id)).toBe(0);
    expect(await skipReasons(id)).toEqual(["agent_unavailable"]);
    // The next occurrence is skipped for the same reason: no second row, the schedule moves on.
    await runner(NEXT_DAY).tick();
    expect(await threadCount(id)).toBe(0);
    expect(await skipReasons(id)).toEqual(["agent_unavailable"]);
    expect((await scheduleRow(id))?.next_due_at?.toISOString()).toBe("2026-10-12T09:00:00.000Z");
  });

  it("an unpublished team agent does not fire", async () => {
    const id = await schedule("dave", financeAgent);
    await adminPg.query(`UPDATE team_agents SET current_version = NULL WHERE id = $1`, [
      financeAgent,
    ]);
    try {
      await adminPg.query(`UPDATE schedules SET next_due_at = $1 WHERE id = $2`, [DUE, id]);
      await runner(NOW).tick();
      expect(await threadCount(id)).toBe(0);
      expect(await skipReasons(id)).toEqual(["agent_unavailable"]);
    } finally {
      await adminPg.query(
        `UPDATE team_agents SET current_version = (SELECT max(version) FROM team_agent_versions
          WHERE agent_id = $1) WHERE id = $1`,
        [financeAgent],
      );
    }
  });
});

describe("an admin pause does not outlive the owner's deactivation or removal (review MEDIUM-1)", () => {
  /** A team-admin pause left on an offboarded owner's schedule (e.g. a hook that failed). */
  const forceAdminPause = (id: string) =>
    adminPg.query(`UPDATE schedules SET paused_by = 'team_admin' WHERE id = $1`, [id]);

  it("deactivation turns an admin pause into the owner's; only the owner resumes after reactivation", async () => {
    const id = await schedule("fred", financeAgent);
    expect((await as.admin.post(`/v1/schedules/${id}/pause`)).json.paused_by).toBe("team_admin");
    expect((await siteOwner.post(`/v1/site/users/${ids.fred}/deactivate`)).status).toBe(200);
    expect((await scheduleRow(id))?.paused_by).toBe("deactivation");
    expect((await as.admin.post(`/v1/schedules/${id}/resume`)).status).toBe(404);
    await forceAdminPause(id);
    const refused = await as.admin.post(`/v1/schedules/${id}/resume`);
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("schedule_owner_inactive");
    expect((await scheduleRow(id))?.active).toBe(false);
    await adminPg.query(`UPDATE schedules SET paused_by = 'deactivation' WHERE id = $1`, [id]);
    expect((await siteOwner.post(`/v1/site/users/${ids.fred}/reactivate`)).status).toBe(200);
    expect((await as.admin.post(`/v1/schedules/${id}/resume`)).status).toBe(404);
    await signIn("fred", finance);
    const resumed = await as.fred.post(`/v1/schedules/${id}/resume`);
    expect(resumed.json).toMatchObject({ active: true, paused_by: null });
  });

  it("removal does the same, and an admin cannot revive a removed owner's schedule", async () => {
    const id = await schedule("gina", financeAgent);
    await as.admin.post(`/v1/schedules/${id}/pause`);
    expect((await as.admin.request("DELETE", `/v1/team/members/${ids.gina}`)).status).toBe(204);
    expect((await scheduleRow(id))?.paused_by).toBe("deactivation");
    await forceAdminPause(id);
    const refused = await as.admin.post(`/v1/schedules/${id}/resume`);
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("schedule_owner_inactive");
    expect((await scheduleRow(id))?.active).toBe(false);
  });
});

describe("a failed deactivation step is finished by the scheduler's sweep (KOBE-252)", () => {
  /** The transition cause each cancelled run was reported with. */
  const causes = new Map<string, string>();
  let unsubscribe: () => void = () => undefined;
  beforeAll(() => {
    unsubscribe = deps.runs.onTransition((t) => {
      if (t.to === "cancelled") causes.set(t.run.run_id, t.cause);
    });
  });
  afterAll(() => unsubscribe());

  it("a removal whose run cancel failed: the run is cancelled at the next tick, once", async () => {
    const id = await schedule("hank", financeAgent);
    const [runId] = (await fire([id])) as [string];
    const cancel = deps.runs.cancelScheduledRuns;
    deps.runs.cancelScheduledRuns = () => Promise.reject(new Error("database went away"));
    try {
      const removed = await as.admin.request("DELETE", `/v1/team/members/${ids.hank}`);
      expect(removed.status, JSON.stringify(removed.json)).toBe(204);
    } finally {
      deps.runs.cancelScheduledRuns = cancel;
    }
    // The pause commits with the removal; only the cancel was left undone.
    expect((await scheduleRow(id))?.paused_by).toBe("deactivation");
    expect(await runStatus(runId)).toBe("running");
    await runner(NOW).tick();
    expect(await runStatus(runId)).toBe("cancelled");
    expect(await cancelAudit(runId)).toEqual([{ actor_kind: "system", reason: "member_removed" }]);
    expect(causes.get(runId)).toBe("system_cancelled");
    await runner(NOW).tick();
    expect(await cancelAudit(runId)).toHaveLength(1);
    expect(await scheduleAudit(id)).toHaveLength(1);
  });

  it("a deactivation whose schedule step never ran: paused and cancelled at the next tick", async () => {
    const id = await schedule("ivy", financeAgent);
    const [runId] = (await fire([id])) as [string];
    // Deactivated without the lifecycle hooks (as if the schedules hook failed in every team).
    await adminPg.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [ids.ivy]);
    await runner(NOW).tick();
    expect(await scheduleRow(id)).toEqual({
      active: false,
      paused_by: "deactivation",
      next_due_at: null,
    });
    expect(await scheduleAudit(id)).toEqual([
      { action: "schedule.deactivated", actor_kind: "system", by: "deactivation" },
    ]);
    expect(await runStatus(runId)).toBe("cancelled");
    expect(await cancelAudit(runId)).toEqual([
      { actor_kind: "system", reason: "owner_deactivated" },
    ]);
    expect(causes.get(runId)).toBe("system_cancelled");
  });

  it("a user's own Stop is still user_cancelled", async () => {
    const id = await schedule("carol", financeAgent);
    const [runId] = (await fire([id])) as [string];
    const stopped = await as.carol.post(`/v1/runs/${runId}/cancel`);
    expect(stopped.status, JSON.stringify(stopped.json)).toBe(200);
    expect(causes.get(runId)).toBe("user_cancelled");
  });
});

describe("cancelling scheduled runs keeps going past a busy run (review LOW-2)", () => {
  it("logs and skips the run it cannot lock, cancels the rest, then reports the failure", async () => {
    await switchTo("erin", marketing);
    const first = await schedule("erin", marketingAgent);
    const second = await schedule("erin", marketingAgent);
    const runIds = await fire([first, second]);
    const errors: unknown[] = [];
    let calls = 0;
    const result = cancelScheduledRuns(
      {
        db: deps.database.db,
        withRetry: (fn) => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error("thread busy")) : fn();
        },
        emit: () => undefined,
        stopThenAdvance: () => undefined,
        log: { error: (obj: unknown) => errors.push(obj) },
      },
      marketing,
      ids.erin,
      "member_removed",
    );
    await expect(result).rejects.toThrow(/could not be cancelled/);
    // Whichever run hit the busy thread is still running; every other one is cancelled.
    const left = await rows<{ status: string }>(
      `SELECT r.status FROM runs r JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
        WHERE r.team_id = $1 AND t.owner_user_id = $2 AND r.trigger = 'schedule'`,
      [marketing, ids.erin],
    );
    expect(left.filter((r) => r.status === "running")).toHaveLength(1);
    expect(left.filter((r) => r.status === "cancelled").length).toBeGreaterThanOrEqual(
      runIds.length - 1,
    );
    expect(errors).toHaveLength(1);
  });
});

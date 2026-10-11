import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { createApp } from "../app.js";
import { createServerDeps, type ServerDeps } from "../deps.js";
import type { ScheduledSubmit } from "../runs/scheduled-submit.js";
import { waitForAppSessionsToClose } from "../testing/app-sessions.js";
import { TestBrowser } from "../testing/browser.js";
import { MemoryMailer } from "../testing/mailer.js";
import { SchedulerRunner } from "./runner.js";

/**
 * Scheduler runner (KOBE-174): three runner instances (three server deps, three pools) on one
 * database with a fixed clock. Exactly-once firing, a crash mid-fire, the run gate at fire time,
 * and catch-up after downtime.
 */
const PUBLIC_URL = "http://kobe.test";
const PASSWORD = "a long enough password";
const ANY = { "if-match": "*" };
const GRACE_MS = 60 * 60_000;
const NOW = new Date("2026-10-10T09:20:00Z");
const DUE = new Date("2026-10-10T09:00:00Z");

const team = randomUUID();
let database: TestDatabase;
let admin: pg.Client;
let owners: ServerDeps[] = [];
let blocked: ServerDeps;
let bob: string;
let carol: string;
let agent: string;
let suspendedAgent: string;

const mailer = () => new MemoryMailer();
const makeDeps = (extra: Partial<Parameters<typeof createServerDeps>[0]> = {}) =>
  createServerDeps({
    databaseUrl: database.appUrl,
    publicUrl: PUBLIC_URL,
    authSecret: "t".repeat(48),
    setupToken: "setup-token-for-agent-tests-0123",
    trustedProxies: ["127.0.0.1/32"],
    mailer: mailer(),
    runs: { sweep: false },
    ...extra,
  });
const runnerOn = (deps: ServerDeps, runs = deps.runs, now = NOW) =>
  new SchedulerRunner({ db: deps.database.db, runs, now: () => now, graceMs: GRACE_MS });

async function addSchedule(
  userId: string,
  opts: { agentId?: string; dueAt?: Date; recurrence?: object; active?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO schedules (team_id, id, user_id, agent_id, prompt, recurrence, tz, active, next_due_at)
     VALUES ($1, $2, $3, $4, 'Summarise the ledger', $5, 'UTC', $6, $7)`,
    [
      team,
      id,
      userId,
      opts.agentId ?? agent,
      JSON.stringify(opts.recurrence ?? { kind: "daily", at: "09:00" }),
      opts.active ?? true,
      opts.active === false ? null : (opts.dueAt ?? DUE),
    ],
  );
  return id;
}

async function rows<T extends object>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await admin.query(sql, params)).rows as T[];
}
const threadsOf = (scheduleId: string) =>
  rows<{ id: string; owner_user_id: string }>(
    `SELECT id, owner_user_id FROM threads WHERE team_id = $1 AND schedule_id = $2`,
    [team, scheduleId],
  );
const fires = (scheduleId: string) =>
  rows<{ due_at: Date }>(
    `SELECT due_at FROM events WHERE team_id = $1 AND kind = 'schedule.fire' AND ref->>'schedule_id' = $2`,
    [team, scheduleId],
  );
const skips = (scheduleId: string) =>
  rows<{ reason: string }>(
    `SELECT ref->>'reason' AS reason FROM events
      WHERE team_id = $1 AND kind = 'schedule.skip' AND ref->>'schedule_id' = $2 ORDER BY created_at`,
    [team, scheduleId],
  );
const nextDue = async (id: string) =>
  (
    await rows<{ next_due_at: Date | null }>(`SELECT next_due_at FROM schedules WHERE id = $1`, [
      id,
    ])
  )[0]?.next_due_at ?? null;

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  owners = [makeDeps(), makeDeps(), makeDeps()];
  // The budget gate refuses everything on this one (a used-up budget).
  blocked = makeDeps({ runs: { sweep: false, budget: { allowsNewRun: async () => false } } });
  const first = owners[0] as ServerDeps;
  const app = createApp(first);
  const people = {} as Record<"bob" | "carol", string>;
  for (const who of ["bob", "carol"] as const) {
    const user = await first.createUserWithPassword(
      { email: `${who}@runner.test`, name: who, password: PASSWORD },
      {},
    );
    people[who] = user.id;
  }
  bob = people.bob;
  carol = people.carol;
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'runner', 'Runner')`, [team]);
  for (const id of [bob, carol]) {
    await admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'builder')`,
      [team, id],
    );
  }
  const b = new TestBrowser(app, PUBLIC_URL);
  expect(
    (await b.post("/api/auth/sign-in/email", { email: "bob@runner.test", password: PASSWORD }))
      .status,
  ).toBe(200);
  expect((await b.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
  b.team = team;
  const publish = async (name: string) => {
    const created = await b.post("/v1/agents", {
      scope: "team",
      frontmatter: { name, description: `${name} does things` },
      prompt: `You are ${name}.`,
    });
    const id = created.json.agent.id as string;
    expect((await b.request("POST", `/v1/agents/${id}/publish`, {}, ANY)).status).toBe(201);
    return id;
  };
  agent = await publish("Runner Bot");
  suspendedAgent = await publish("Sleepy Bot");
  await admin.query(`UPDATE team_agents SET status = 'suspended' WHERE id = $1`, [suspendedAgent]);
});

afterAll(async () => {
  for (const d of [...owners, blocked]) d?.runs.close();
  await admin?.end();
  await Promise.all([...owners, blocked].map((d) => d?.close()));
  if (database) {
    await waitForAppSessionsToClose(database.appRole);
    await database.drop();
  }
});

describe("exactly-once firing across three instances (ac-1)", () => {
  it("12 due schedules produce 12 threads and 12 runs, none duplicated", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) ids.push(await addSchedule(i % 2 === 0 ? bob : carol));
    const runners = owners.map((d) => runnerOn(d));
    await Promise.all(runners.map((r) => r.tick()));
    // A second pass finds nothing left to do, and a late instance changes nothing.
    await Promise.all(runners.map((r) => r.tick()));
    for (const id of ids) {
      expect(await threadsOf(id), id).toHaveLength(1);
      expect(await fires(id), id).toHaveLength(1);
      expect((await nextDue(id))?.toISOString()).toBe("2026-10-11T09:00:00.000Z");
    }
    const runs = await rows<{ trigger: string; approval_mode: string; thread_id: string }>(
      `SELECT r.trigger, r.approval_mode, r.thread_id FROM runs r JOIN threads t
         ON t.team_id = r.team_id AND t.id = r.thread_id
        WHERE r.team_id = $1 AND t.schedule_id = ANY($2)`,
      [team, ids],
    );
    expect(runs).toHaveLength(12);
    expect(new Set(runs.map((r) => r.thread_id)).size).toBe(12);
    expect(runs.every((r) => r.trigger === "schedule" && r.approval_mode === "auto")).toBe(true);
    const owned = await rows<{ owner_user_id: string }>(
      `SELECT owner_user_id FROM threads WHERE team_id = $1 AND schedule_id = ANY($2)`,
      [team, ids],
    );
    expect(owned.filter((t) => t.owner_user_id === bob)).toHaveLength(6);
    const linked = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM schedules WHERE id = ANY($1) AND last_run_id IS NOT NULL`,
      [ids],
    );
    expect(linked[0]?.n).toBe(12);
  });

  it("an instance that dies mid-fire loses nothing and duplicates nothing", async () => {
    const id = await addSchedule(bob);
    const [dying, healthy1, healthy2] = owners as [ServerDeps, ServerDeps, ServerDeps];
    // The first instance crashes after claiming everything, just before its commit.
    const crashing = {
      submitMessage: (
        ...args: Parameters<ServerDeps["runs"]["submitMessage"]>
      ): ReturnType<ServerDeps["runs"]["submitMessage"]> => {
        const [actor, command, options] = args;
        const scheduled = options?.scheduled as ScheduledSubmit;
        return dying.runs.submitMessage(actor, command, {
          ...options,
          scheduled: {
            before: (tx) => scheduled.before(tx),
            after: async () => {
              throw new Error("instance killed");
            },
          },
        });
      },
    };
    expect((await runnerOn(dying, crashing as ServerDeps["runs"]).tick()).failed).toBe(1);
    expect(await threadsOf(id)).toHaveLength(0);
    expect(await fires(id)).toHaveLength(0);
    expect((await nextDue(id))?.toISOString()).toBe(DUE.toISOString());
    await Promise.all([
      runnerOn(healthy1).tick(),
      runnerOn(healthy2).tick(),
      runnerOn(dying).tick(),
    ]);
    expect(await threadsOf(id)).toHaveLength(1);
    expect(await fires(id)).toHaveLength(1);
  });

  it("skips a schedule another instance holds, and fires it once the lease is gone", async () => {
    const id = await addSchedule(carol);
    const holder = new pg.Client({ connectionString: database.adminUrl });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query(`SELECT 1 FROM schedules WHERE id = $1 FOR UPDATE`, [id]);
    const [a, b] = owners as [ServerDeps, ServerDeps, ServerDeps];
    expect(await runnerOn(a).tick()).toMatchObject({ fired: 0, skipped: 0 });
    expect(await threadsOf(id)).toHaveLength(0);
    // The holder's connection dies (pod killed): Postgres releases the lease.
    await holder.query("ROLLBACK");
    await holder.end();
    await runnerOn(b).tick();
    expect(await threadsOf(id)).toHaveLength(1);
  });

  it("the unique index stops a second fire of the same occurrence", async () => {
    const id = await addSchedule(bob);
    await runnerOn(owners[0] as ServerDeps).tick();
    // Resume/edit put the same occurrence back as due: it is consumed, not run again.
    await admin.query(`UPDATE schedules SET next_due_at = $2 WHERE id = $1`, [id, DUE]);
    await runnerOn(owners[1] as ServerDeps).tick();
    expect(await threadsOf(id)).toHaveLength(1);
    expect(await skips(id)).toEqual([{ reason: "duplicate" }]);
    expect((await nextDue(id))?.toISOString()).toBe("2026-10-11T09:00:00.000Z");
  });
});

describe("the run gate at fire time (ac-2)", () => {
  it("a budget-blocked run fails visibly, once, and the schedule moves on", async () => {
    const id = await addSchedule(bob);
    const r = runnerOn(blocked);
    expect(await r.tick()).toMatchObject({ fired: 1, failed: 0 });
    const [thread] = await threadsOf(id);
    const runs = await rows<{ status: string; trigger: string }>(
      `SELECT status, trigger FROM runs WHERE team_id = $1 AND thread_id = $2`,
      [team, thread?.id],
    );
    expect(runs).toEqual([{ status: "failed", trigger: "schedule" }]);
    const ev = await rows<{ type: string }>(
      `SELECT e.type FROM run_events e JOIN runs r ON r.team_id = e.team_id AND r.id = e.run_id
        WHERE r.team_id = $1 AND r.thread_id = $2`,
      [team, thread?.id],
    );
    expect(ev.map((e) => e.type)).toContain("run.failed");
    // The owner is told, once, in the transaction that recorded the failure (KOBE-179).
    const told = await rows<{ kind: string; user_id: string; schedule_id: string }>(
      `SELECT kind, user_id, schedule_id FROM notifications WHERE team_id = $1 AND thread_id = $2`,
      [team, thread?.id],
    );
    expect(told).toEqual([{ kind: "schedule.run.failed", user_id: bob, schedule_id: id }]);
    expect(await fires(id)).toHaveLength(1);
    expect((await nextDue(id))?.toISOString()).toBe("2026-10-11T09:00:00.000Z");
    // No retry storm: further ticks do nothing.
    await r.tick();
    expect(await threadsOf(id)).toHaveLength(1);
  });

  it("a deactivated user, a suspended agent and a paused schedule do not fire", async () => {
    const gone = (
      await rows<{ id: string }>(
        `INSERT INTO users (id, name, email, email_verified, deactivated_at)
         VALUES ($1, 'gone', 'gone@runner.test', true, now()) RETURNING id`,
        [randomUUID()],
      )
    )[0]?.id as string;
    await admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'builder')`,
      [team, gone],
    );
    const deactivated = await addSchedule(gone);
    const suspended = await addSchedule(bob, { agentId: suspendedAgent });
    const paused = await addSchedule(bob, { active: false });
    await runnerOn(owners[2] as ServerDeps).tick();
    for (const id of [deactivated, suspended, paused]) expect(await threadsOf(id)).toHaveLength(0);
    expect(await skips(deactivated)).toEqual([{ reason: "user_inactive" }]);
    expect(await skips(suspended)).toEqual([{ reason: "agent_unavailable" }]);
    expect(await skips(paused)).toEqual([]);
    expect(await nextDue(paused)).toBeNull();
  });

  it("a user who left the team does not fire", async () => {
    const left = (
      await (async () => {
        const id = randomUUID();
        await admin.query(
          `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'left', 'left@runner.test', true)`,
          [id],
        );
        return { id };
      })()
    ).id;
    const id = await addSchedule(left);
    await runnerOn(owners[0] as ServerDeps).tick();
    expect(await threadsOf(id)).toHaveLength(0);
    expect(await skips(id)).toEqual([{ reason: "user_inactive" }]);
  });
});

describe("catch-up after downtime (ac-3)", () => {
  it("fires once for the latest occurrence inside the grace window, records the rest as skipped", async () => {
    const id = await addSchedule(bob, { dueAt: new Date("2026-10-07T09:00:00Z") });
    await runnerOn(owners[0] as ServerDeps).tick();
    await runnerOn(owners[1] as ServerDeps).tick();
    expect(await threadsOf(id)).toHaveLength(1);
    const [fire] = await fires(id);
    expect(fire?.due_at.toISOString()).toBe(DUE.toISOString());
    expect(await skips(id)).toEqual([{ reason: "collapsed" }]);
    expect((await nextDue(id))?.toISOString()).toBe("2026-10-11T09:00:00.000Z");
  });

  it("skips an occurrence older than the grace window and fires nothing", async () => {
    const id = await addSchedule(bob);
    const late = new Date("2026-10-10T15:00:00Z");
    await runnerOn(owners[0] as ServerDeps, owners[0]?.runs, late).tick();
    expect(await threadsOf(id)).toHaveLength(0);
    expect(await skips(id)).toEqual([{ reason: "missed" }]);
    expect((await nextDue(id))?.toISOString()).toBe("2026-10-11T09:00:00.000Z");
  });
});

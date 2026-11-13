import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listNotificationsResponseSchema } from "@kobe/protocol";
import { sql, withTeam } from "@kobe/db";
import pino from "pino";
import {
  MEMORY_DIGEST_AFTER,
  MEMORY_REMINDER_LOCK,
  MemoryReminderJob,
  notifyMemory,
  notifyMemoryAll,
  registerMemoryReminder,
  settleMemoryReminders,
  sweepMemoryReminders,
  type MemoryNotice,
} from "./notifications/memory.js";
import { createPgReconcileLock } from "./sandbox/reconcile-lock.js";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";

/**
 * Memory notifications (KOBE-645, v1.3 SM22): `notifyMemory` records one in-app notification per
 * recipient, rolling more than {@link MEMORY_DIGEST_AFTER} of one kind for one recipient within an
 * hour into one `memory.review.digest`; sources register pending objects for one reminder after 7
 * days, sent by one replica at a time. The bell's list returns every memory kind with its fields.
 */
const fx = new EventStreamFixture();
const silent = pino({ level: "silent" });

beforeAll(async () => {
  await fx.setup([{}, {}]);
});

afterAll(async () => {
  await fx.teardown();
});

interface World {
  readonly team: string;
  readonly ann: Person;
  readonly bob: Person;
}

async function world(): Promise<World> {
  const ann = await fx.person("ann");
  const bob = await fx.person("bob");
  const team = await fx.team(`m-${randomUUID().slice(0, 8)}`, ann, [bob]);
  // Bob is a Workspace memory steward: a curator, like Ann (Team admin).
  await fx.admin.query(
    `INSERT INTO memory_stewards (team_id, user_id, granted_by) VALUES ($1, $2, $3)`,
    [team, bob.id, ann.id],
  );
  return { team, ann, bob };
}

const notify = (team: string, users: readonly string[], notice: MemoryNotice) =>
  withTeam(fx.db, team, (tx) => notifyMemory(tx, team, users, notice));

const proposal = (actor?: string): MemoryNotice => ({
  kind: "memory.proposal.received",
  objectId: randomUUID(),
  ...(actor ? { actorUserId: actor } : {}),
});

async function rows(team: string, user?: string) {
  const { rows: r } = await fx.admin.query<{
    id: string;
    user_id: string;
    kind: string;
    related_kind: string | null;
    item_count: number | null;
    memory_object_id: string | null;
    read_at: Date | null;
  }>(
    `SELECT id, user_id, kind, related_kind, item_count, memory_object_id, read_at
       FROM notifications WHERE team_id = $1 AND ($2::uuid IS NULL OR user_id = $2)
      ORDER BY created_at, id`,
    [team, user ?? null],
  );
  return r;
}

describe("notifyMemory and the digest (ac-2)", () => {
  it("rolls more than five of one kind per recipient within an hour into one digest", async () => {
    const w = await world();
    const results = [];
    for (let i = 0; i < 8; i++) results.push(...(await notify(w.team, [w.bob.id], proposal())));
    expect(results.map((r) => r.outcome)).toEqual([
      ...Array<string>(MEMORY_DIGEST_AFTER).fill("notified"),
      "digested",
      "digested",
      "digested",
    ]);
    const mine = await rows(w.team, w.bob.id);
    expect(mine.filter((r) => r.kind === "memory.proposal.received")).toHaveLength(5);
    const digests = mine.filter((r) => r.kind === "memory.review.digest");
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({
      related_kind: "memory.proposal.received",
      item_count: 3,
    });
    // Another kind and another recipient count on their own.
    await notify(w.team, [w.bob.id], { kind: "memory.scope.near_full", scope: "team" });
    await notify(w.team, [w.ann.id], proposal());
    expect((await rows(w.team, w.bob.id)).at(-1)?.kind).toBe("memory.scope.near_full");
    expect((await rows(w.team, w.ann.id)).map((r) => r.kind)).toEqual(["memory.proposal.received"]);
  });

  it("a digest the recipient read turns unread when it grows; a new hour starts afresh", async () => {
    const w = await world();
    for (let i = 0; i < 6; i++) await notify(w.team, [w.bob.id], proposal());
    const digest = must(
      (await rows(w.team, w.bob.id)).find((r) => r.kind === "memory.review.digest"),
      "digest",
    );
    await fx.admin.query(`UPDATE notifications SET read_at = now() WHERE id = $1`, [digest.id]);
    await notify(w.team, [w.bob.id], proposal());
    const grown = must(
      (await rows(w.team, w.bob.id)).find((r) => r.id === digest.id),
      "digest after",
    );
    expect(grown).toMatchObject({ item_count: 2, read_at: null });
    // An hour later the window is empty again: the next one is a notification of its own.
    await fx.admin.query(
      `UPDATE notifications SET created_at = created_at - interval '61 minutes' WHERE team_id = $1`,
      [w.team],
    );
    const [next] = await notify(w.team, [w.bob.id], proposal());
    expect(next?.outcome).toBe("notified");
  });

  it("concurrent notifications still roll up exactly (one lock per recipient and kind)", async () => {
    const w = await world();
    await Promise.all(
      Array.from({ length: 10 }, () => notify(w.team, [w.bob.id], proposal(w.ann.id))),
    );
    const mine = await rows(w.team, w.bob.id);
    expect(mine.filter((r) => r.kind === "memory.proposal.received")).toHaveLength(5);
    expect(mine.filter((r) => r.kind === "memory.review.digest")).toMatchObject([
      { item_count: 5 },
    ]);
  });

  it("skips recipients who are not active members of the Workspace", async () => {
    const w = await world();
    const outsider = await fx.person("outsider");
    await fx.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [w.bob.id]);
    const out = await notify(w.team, [w.bob.id, outsider.id, w.ann.id], proposal());
    expect(out.map((r) => r.userId)).toEqual([w.ann.id]);
    expect((await rows(w.team)).map((r) => r.user_id)).toEqual([w.ann.id]);
  });
});

describe("notifyMemory contracts (review L1, L6)", () => {
  it("several notices in one transaction take their locks in one order (no deadlock)", async () => {
    const w = await world();
    const accepted: MemoryNotice = { kind: "memory.proposal.accepted", objectId: randomUUID() };
    // Two transactions notify the same two people of two kinds, listed in opposite orders.
    const a = withTeam(fx.db, w.team, (tx) =>
      notifyMemoryAll(tx, w.team, [
        { recipients: [w.ann.id], notice: proposal() },
        { recipients: [w.bob.id], notice: accepted },
      ]).then(() => tx.execute(sql`SELECT pg_sleep(0.2)`)),
    );
    const b = withTeam(fx.db, w.team, (tx) =>
      notifyMemoryAll(tx, w.team, [
        { recipients: [w.bob.id], notice: accepted },
        { recipients: [w.ann.id], notice: proposal() },
      ]).then(() => tx.execute(sql`SELECT pg_sleep(0.2)`)),
    );
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
    expect(await rows(w.team)).toHaveLength(4);
  });

  it("refuses an actor or thread from outside the recipient's Workspace", async () => {
    const w = await world();
    const outsider = await fx.person("outsider");
    await expect(notify(w.team, [w.bob.id], proposal(outsider.id))).rejects.toThrow(/actor/);
    const other = await world();
    const { rows: t } = await fx.admin.query<{ id: string }>(
      `INSERT INTO threads (team_id, owner_user_id, title) VALUES ($1, $2, 't') RETURNING id`,
      [w.team, w.ann.id],
    );
    const annThread = must(t[0], "thread").id;
    // Ann's thread is not Bob's.
    await expect(
      notify(w.team, [w.bob.id], {
        kind: "memory.review.candidates_ready",
        threadId: annThread,
        count: 2,
      }),
    ).rejects.toThrow(/thread/);
    // A Site curator may decide a Site proposal without being a member.
    await fx.admin.query(
      `INSERT INTO site_grants (user_id, "grant", granted_by) VALUES ($1, 'memory_steward', $1)`,
      [other.ann.id],
    );
    await expect(
      notify(w.team, [w.ann.id], {
        kind: "memory.site_proposal.accepted",
        objectId: randomUUID(),
        actorUserId: other.ann.id,
      }),
    ).resolves.toHaveLength(1);
  });
});

describe("the bell's list returns memory kinds (ac-3)", () => {
  it("lists each memory kind with what it names", async () => {
    const w = await world();
    const project = randomUUID();
    await fx.admin.query(
      `INSERT INTO projects (team_id, id, slug, name, created_by) VALUES ($1, $2, $3, 'P', $4)`,
      [w.team, project, `p-${project.slice(0, 8)}`, w.ann.id],
    );
    const object = randomUUID();
    await notify(w.team, [w.bob.id], { kind: "memory.scope.near_full", scope: "site" });
    await notify(w.team, [w.bob.id], {
      kind: "memory.suggestion.received",
      objectId: object,
      projectId: project,
      actorUserId: w.ann.id,
    });
    await notify(w.team, [w.bob.id], {
      kind: "memory.review.reminder",
      objectId: object,
      about: "memory.suggestion.received",
      projectId: project,
    });
    const threadId = must(
      (
        await fx.admin.query<{ id: string }>(
          `INSERT INTO threads (team_id, owner_user_id, title) VALUES ($1, $2, 't') RETURNING id`,
          [w.team, w.bob.id],
        )
      ).rows[0],
      "thread",
    ).id;
    await notify(w.team, [w.bob.id], {
      kind: "memory.review.candidates_ready",
      threadId,
      count: 3,
    });
    const res = await w.bob.browser.get("/v1/notifications");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const list = listNotificationsResponseSchema.parse(res.json);
    expect(list.unread_count).toBe(4);
    expect(list.notifications.map((n) => n.kind).sort()).toEqual([
      "memory.review.candidates_ready",
      "memory.review.reminder",
      "memory.scope.near_full",
      "memory.suggestion.received",
    ]);
    const suggestion = must(
      list.notifications.find((n) => n.kind === "memory.suggestion.received"),
      "suggestion",
    );
    expect(suggestion).toMatchObject({
      memory_object_id: object,
      project_id: project,
      actor_name: "ann",
      schedule_id: null,
      thread_id: null,
    });
    expect(
      list.notifications.find((n) => n.kind === "memory.review.candidates_ready"),
    ).toMatchObject({ thread_id: threadId, item_count: 3, run_id: null });
    expect(list.notifications.find((n) => n.kind === "memory.scope.near_full")).toMatchObject({
      memory_scope: "site",
    });
    expect(list.notifications.find((n) => n.kind === "memory.review.reminder")).toMatchObject({
      related_kind: "memory.suggestion.received",
      memory_object_id: object,
      project_id: project,
    });
    // Not Ann's.
    const ann = listNotificationsResponseSchema.parse(
      (await w.ann.browser.get("/v1/notifications")).json,
    );
    expect(ann.notifications).toEqual([]);
  });
});

describe("reminders (ac-2)", () => {
  const due = (team: string) =>
    fx.admin.query(
      `UPDATE memory_reminders SET due_at = now() - interval '1 second' WHERE team_id = $1`,
      [team],
    );
  const register = (team: string, objectId: string, recipients: readonly string[]) =>
    withTeam(fx.db, team, (tx) =>
      registerMemoryReminder(tx, team, {
        objectId,
        about: "memory.proposal.received",
        recipients,
      }),
    );
  const reminders = async (team: string) =>
    (await rows(team)).filter((r) => r.kind === "memory.review.reminder");

  it("fires once per pending object and recipient after 7 days", async () => {
    const w = await world();
    const objectId = randomUUID();
    await register(w.team, objectId, [w.ann.id, w.bob.id]);
    const { rows: reg } = await fx.admin.query<{ days: number }>(
      `SELECT round(extract(epoch FROM due_at - created_at) / 86400)::int AS days
         FROM memory_reminders WHERE team_id = $1`,
      [w.team],
    );
    expect(reg.map((r) => r.days)).toEqual([7, 7]);
    await sweepMemoryReminders(fx.db);
    expect(await reminders(w.team)).toEqual([]);
    await due(w.team);
    await sweepMemoryReminders(fx.db);
    const sent = await reminders(w.team);
    expect(sent.map((r) => [r.user_id, r.memory_object_id, r.related_kind]).sort()).toEqual(
      [
        [w.ann.id, objectId, "memory.proposal.received"],
        [w.bob.id, objectId, "memory.proposal.received"],
      ].sort(),
    );
    // Registering again (a retry) and sweeping again send nothing more.
    await register(w.team, objectId, [w.ann.id, w.bob.id]);
    await due(w.team);
    await sweepMemoryReminders(fx.db);
    expect(await reminders(w.team)).toHaveLength(2);
  });

  it("sends nothing for an object decided before its reminder", async () => {
    const w = await world();
    const objectId = randomUUID();
    await register(w.team, objectId, [w.bob.id]);
    await withTeam(fx.db, w.team, (tx) => settleMemoryReminders(tx, w.team, objectId));
    await due(w.team);
    await sweepMemoryReminders(fx.db);
    expect(await reminders(w.team)).toEqual([]);
  });

  it("exactly one replica runs the reminder pass; each reminder is sent once", async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) await register(w.team, randomUUID(), [w.bob.id]);
    await due(w.team);
    const jobs = [0, 1].map(
      (i) =>
        new MemoryReminderJob({
          db: fx.replica(i).deps.database.db,
          lock: createPgReconcileLock(
            fx.replica(i).deps.database.pool,
            () => undefined,
            MEMORY_REMINDER_LOCK,
          ),
          logger: silent,
        }),
    );
    // Hold the lock as a third party: neither replica runs.
    const holder = createPgReconcileLock(
      fx.replica(0).deps.database.pool,
      () => undefined,
      MEMORY_REMINDER_LOCK,
    );
    const blocked = await holder.runExclusive(() => Promise.all(jobs.map((j) => j.runOnce())));
    expect(blocked.ran && blocked.value.map((o) => o.ran)).toEqual([false, false]);
    expect(await reminders(w.team)).toEqual([]);
    const outcomes = await Promise.all(jobs.map((j) => j.runOnce()));
    expect(outcomes.filter((o) => o.ran).length).toBeGreaterThanOrEqual(1);
    // Even unlocked sweeps racing each other send each reminder once (rows claimed SKIP LOCKED).
    await Promise.all([sweepMemoryReminders(fx.db), sweepMemoryReminders(fx.db)]);
    expect(await reminders(w.team)).toHaveLength(3);
  });

  it("re-checks the recipient's right at send and drops the reminder if it is gone (review M1)", async () => {
    const w = await world();
    const project = randomUUID();
    await fx.admin.query(
      `INSERT INTO projects (team_id, id, slug, name, created_by) VALUES ($1, $2, $3, 'P', $4)`,
      [w.team, project, `p-${project.slice(0, 8)}`, w.ann.id],
    );
    await fx.admin.query(
      `INSERT INTO project_members (team_id, project_id, user_id, role, added_by)
       VALUES ($1, $2, $3, 'editor', $4)`,
      [w.team, project, w.bob.id, w.ann.id],
    );
    const proposalId = randomUUID();
    const suggestionId = randomUUID();
    const siteId = randomUUID();
    await withTeam(fx.db, w.team, async (tx) => {
      await registerMemoryReminder(tx, w.team, {
        objectId: proposalId,
        about: "memory.proposal.received",
        recipients: [w.bob.id],
      });
      await registerMemoryReminder(tx, w.team, {
        objectId: suggestionId,
        about: "memory.suggestion.received",
        projectId: project,
        recipients: [w.bob.id],
      });
      // Waiting for the Site: Bob is neither a Site admin nor a Site steward.
      await registerMemoryReminder(tx, w.team, {
        objectId: siteId,
        about: "memory.site_proposal.confirmed",
        recipients: [w.bob.id],
      });
    });
    // Bob loses stewardship and the project.
    await fx.admin.query(`DELETE FROM memory_stewards WHERE team_id = $1`, [w.team]);
    await fx.admin.query(`DELETE FROM project_members WHERE team_id = $1`, [w.team]);
    await due(w.team);
    await sweepMemoryReminders(fx.db);
    expect(await reminders(w.team)).toEqual([]);
    const { rows: left } = await fx.admin.query(
      `SELECT 1 FROM memory_reminders WHERE team_id = $1`,
      [w.team],
    );
    expect(left).toEqual([]);
  });

  it("keeps sweeping other Workspaces when one fails (review L3)", async () => {
    const bad = await world();
    const good = await world();
    await register(bad.team, randomUUID(), [bad.bob.id]);
    await register(good.team, randomUUID(), [good.bob.id]);
    await due(bad.team);
    await due(good.team);
    const fn = `kobe_test_fail_${randomUUID().replaceAll("-", "")}`;
    await fx.admin.query(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $f$
       BEGIN IF NEW.team_id = '${bad.team}'::uuid THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $f$`,
    );
    await fx.admin.query(
      `CREATE TRIGGER ${fn} BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
    try {
      await sweepMemoryReminders(fx.db);
    } finally {
      await fx.admin.query(`DROP TRIGGER ${fn} ON notifications`);
      await fx.admin.query(`DROP FUNCTION ${fn}()`);
    }
    expect(await reminders(good.team)).toHaveLength(1);
    expect(await reminders(bad.team)).toEqual([]);
    // The failed Workspace's reminder is still owed and goes out on the next pass.
    await sweepMemoryReminders(fx.db);
    expect(await reminders(bad.team)).toHaveLength(1);
  });

  it("rolls a burst of due reminders into the digest like any other kind", async () => {
    const w = await world();
    for (let i = 0; i < 7; i++) await register(w.team, randomUUID(), [w.bob.id]);
    await due(w.team);
    await sweepMemoryReminders(fx.db);
    const mine = await rows(w.team, w.bob.id);
    expect(mine.filter((r) => r.kind === "memory.review.reminder")).toHaveLength(5);
    expect(mine.filter((r) => r.kind === "memory.review.digest")).toMatchObject([
      { related_kind: "memory.review.reminder", item_count: 2 },
    ]);
    const { rows: left } = await fx.admin.query(
      `SELECT 1 FROM memory_reminders WHERE team_id = $1 AND sent_at IS NULL`,
      [w.team],
    );
    expect(left).toEqual([]);
  });
});

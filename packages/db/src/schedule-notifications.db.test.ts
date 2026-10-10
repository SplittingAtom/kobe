import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import {
  notificationEmails,
  notifications,
  runSkippedActions,
  runs,
  schedules,
  teams,
  threads,
  users,
} from "./schema/index.js";
import { withTeam } from "./with-team.js";

/** KOBE-177: notifications, their email outbox and skipped actions (spec D32). */
type NewNotification = typeof notifications.$inferInsert;
let app: KobeDatabase;
let owner: KobeDatabase;
const teamA = randomUUID();
const teamB = randomUUID();
const userId = randomUUID();
const pgCode = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code;

async function seed(teamId: string) {
  const scheduleId = randomUUID();
  await withTeam(app.db, teamId, (tx) =>
    tx.insert(schedules).values({
      teamId,
      id: scheduleId,
      userId,
      agentId: randomUUID(),
      prompt: "p",
      recurrence: { kind: "daily", at: "08:00" },
      tz: "UTC",
    }),
  );
  const [thread] = await withTeam(app.db, teamId, (tx) =>
    tx.insert(threads).values({ teamId, ownerUserId: userId, scheduleId }).returning(),
  );
  if (!thread) throw new Error("thread");
  const [run] = await withTeam(app.db, teamId, (tx) =>
    tx.insert(runs).values({ teamId, threadId: thread.id, trigger: "schedule" }).returning(),
  );
  if (!run) throw new Error("run");
  return { scheduleId, threadId: thread.id, runId: run.id };
}

const note = (
  teamId: string,
  s: { scheduleId: string; threadId: string; runId: string },
): NewNotification => ({
  teamId,
  userId,
  kind: "schedule.run.skipped_actions",
  scheduleId: s.scheduleId,
  threadId: s.threadId,
  runId: s.runId,
  skippedCount: 2,
});
const skip = (teamId: string, runId: string, toolCallId = "call-1") => ({
  teamId,
  runId,
  toolCallId,
  tool: "bash",
  riskClass: "write" as const,
  reason: "scheduled_run_no_prompt",
});

beforeAll(async () => {
  owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `na-${teamA.slice(0, 8)}`, name: "Notif A" },
    { id: teamB, slug: `nb-${teamB.slice(0, 8)}`, name: "Notif B" },
  ]);
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values({ id: userId, name: "N", email: `${userId}@n.test` });
});
afterAll(async () => {
  await app.close();
  await owner.close();
});

describe("notifications", () => {
  it("is team-isolated and defaults unread", async () => {
    const s = await seed(teamA);
    const [n] = await withTeam(app.db, teamA, (tx) =>
      tx.insert(notifications).values(note(teamA, s)).returning(),
    );
    expect(n).toMatchObject({ readAt: null, skippedCount: 2, pausedBy: null });
    expect(await withTeam(app.db, teamB, (tx) => tx.select().from(notifications))).toEqual([]);
    await expect(
      withTeam(app.db, teamB, (tx) => tx.insert(notifications).values(note(teamA, s))),
    ).rejects.toSatisfy((e) => pgCode(e) === "42501");
  });

  it("enforces kind and the thread/run/paused_by shape", async () => {
    const s = await seed(teamA);
    const bad: NewNotification[] = [
      { ...note(teamA, s), kind: "schedule.nope" as NewNotification["kind"] },
      { ...note(teamA, s), threadId: null },
      { ...note(teamA, s), runId: null },
      { ...note(teamA, s), pausedBy: "team_admin" as const },
      { ...note(teamA, s), skippedCount: -1 },
      { ...note(teamA, s), kind: "schedule.paused" },
      { ...note(teamA, s), kind: "schedule.paused", threadId: null, runId: null },
    ];
    for (const row of bad) {
      await expect(
        withTeam(app.db, teamA, (tx) => tx.insert(notifications).values(row)),
      ).rejects.toSatisfy((e) => pgCode(e) === "23514");
    }
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(notifications).values({
        teamId: teamA,
        userId,
        kind: "schedule.paused",
        scheduleId: s.scheduleId,
        pausedBy: "deactivation",
      }),
    );
  });

  it("emits one notification per run and kind", async () => {
    const s = await seed(teamA);
    await withTeam(app.db, teamA, (tx) => tx.insert(notifications).values(note(teamA, s)));
    await expect(
      withTeam(app.db, teamA, (tx) => tx.insert(notifications).values(note(teamA, s))),
    ).rejects.toSatisfy((e) => pgCode(e) === "23505");
  });
});

describe("notification_emails", () => {
  it("queues one email per notification, with defaults and checks", async () => {
    const s = await seed(teamA);
    const [n] = await withTeam(app.db, teamA, (tx) =>
      tx.insert(notifications).values(note(teamA, s)).returning(),
    );
    if (!n) throw new Error("notification");
    const mail = { teamId: teamA, notificationId: n.id, recipientId: userId };
    const [e] = await withTeam(app.db, teamA, (tx) =>
      tx.insert(notificationEmails).values(mail).returning(),
    );
    expect(e).toMatchObject({ status: "pending", attempts: 0, leaseUntil: null, sentAt: null });
    await expect(
      withTeam(app.db, teamA, (tx) => tx.insert(notificationEmails).values(mail)),
    ).rejects.toSatisfy((x) => pgCode(x) === "23505");
    await expect(
      withTeam(app.db, teamA, (tx) =>
        tx.update(notificationEmails).set({ lastError: "Bad Text!" }),
      ),
    ).rejects.toSatisfy((x) => pgCode(x) === "23514");
    expect(await withTeam(app.db, teamB, (tx) => tx.select().from(notificationEmails))).toEqual([]);
  });
});

describe("run_skipped_actions", () => {
  it("is unique per run and tool call, and validates its columns", async () => {
    const s = await seed(teamA);
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(runSkippedActions).values(skip(teamA, s.runId)),
    );
    await expect(
      withTeam(app.db, teamA, (tx) => tx.insert(runSkippedActions).values(skip(teamA, s.runId))),
    ).rejects.toSatisfy((e) => pgCode(e) === "23505");
    for (const bad of [
      { ...skip(teamA, s.runId, "c2"), riskClass: "nuclear" as "write" },
      { ...skip(teamA, s.runId, "c3"), tool: "" },
      { ...skip(teamA, s.runId, "c4"), reason: "Not A Code" },
    ]) {
      await expect(
        withTeam(app.db, teamA, (tx) => tx.insert(runSkippedActions).values(bad)),
      ).rejects.toSatisfy((e) => pgCode(e) === "23514");
    }
    expect(await withTeam(app.db, teamB, (tx) => tx.select().from(runSkippedActions))).toEqual([]);
  });
});

describe("removal with the thread (ac-2)", () => {
  async function fill() {
    const s = await seed(teamA);
    const [n] = await withTeam(app.db, teamA, (tx) =>
      tx.insert(notifications).values(note(teamA, s)).returning(),
    );
    if (!n) throw new Error("notification");
    await withTeam(app.db, teamA, async (tx) => {
      await tx
        .insert(notificationEmails)
        .values({ teamId: teamA, notificationId: n.id, recipientId: userId });
      await tx.insert(runSkippedActions).values(skip(teamA, s.runId));
    });
    return s;
  }
  const counts = (s: { runId: string }) =>
    withTeam(app.db, teamA, async (tx) => ({
      notes: (await tx.select().from(notifications).where(eq(notifications.runId, s.runId))).length,
      skips: (await tx.select().from(runSkippedActions).where(eq(runSkippedActions.runId, s.runId)))
        .length,
    }));

  it("a thread delete removes its notifications, emails and skipped actions", async () => {
    const s = await fill();
    expect(await counts(s)).toEqual({ notes: 1, skips: 1 });
    await withTeam(app.db, teamA, (tx) => tx.delete(threads).where(eq(threads.id, s.threadId)));
    expect(await counts(s)).toEqual({ notes: 0, skips: 0 });
  });

  it("a legal hold on the thread's owner keeps the thread and all of them", async () => {
    const s = await fill();
    // Two install admins place and approve the hold (fixtures as superuser, like retention tests).
    const admin = new pg.Client({ connectionString: inject("adminUrl") });
    await admin.connect();
    try {
      const [placer, approver] = [randomUUID(), randomUUID()];
      for (const id of [placer, approver]) {
        await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, 'Adm', $2)`, [
          id,
          `${id}@n.test`,
        ]);
        await admin.query(`INSERT INTO install_roles (user_id, role) VALUES ($1, 'admin')`, [id]);
      }
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3) RETURNING id`,
        [teamA, userId, placer],
      );
      await admin.query(
        `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
        [rows[0]?.id, approver],
      );
    } finally {
      await admin.end();
    }
    await expect(
      withTeam(app.db, teamA, (tx) => tx.delete(threads).where(eq(threads.id, s.threadId))),
    ).rejects.toSatisfy((e) => pgCode(e) === "KH001");
    expect(await counts(s)).toEqual({ notes: 1, skips: 1 });
  });
});

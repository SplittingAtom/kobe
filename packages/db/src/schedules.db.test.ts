import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { events, schedules, teams, threads, users } from "./schema/index.js";
import { withTeam } from "./with-team.js";

/** KOBE-172: schedules (team table), fire dedup on events, threads.schedule_id. */
let app: KobeDatabase;
const teamA = randomUUID();
const teamB = randomUUID();
const userId = randomUUID();
const pgCode = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code;

const row = (teamId: string, id = randomUUID()) => ({
  teamId,
  id,
  userId,
  agentId: randomUUID(),
  prompt: "Summarise yesterday",
  recurrence: { kind: "daily", at: "08:00" },
  tz: "Europe/Berlin",
});
const fire = (teamId: string, scheduleId: string, dueAt: Date) => ({
  teamId,
  kind: "schedule.fire",
  status: "scheduled" as const,
  ref: { schedule_id: scheduleId },
  dueAt,
});

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `sa-${teamA.slice(0, 8)}`, name: "Sched A" },
    { id: teamB, slug: `sb-${teamB.slice(0, 8)}`, name: "Sched B" },
  ]);
  await owner.close();
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values({ id: userId, name: "S", email: `${userId}@s.test` });
});
afterAll(() => app.close());

describe("schedules", () => {
  it("applies defaults and is isolated per team", async () => {
    const id = randomUUID();
    const [made] = await withTeam(app.db, teamA, (tx) =>
      tx.insert(schedules).values(row(teamA, id)).returning(),
    );
    expect(made).toMatchObject({ active: true, pausedBy: null, nextDueAt: null, lastRunId: null });
    expect(await withTeam(app.db, teamB, (tx) => tx.select().from(schedules))).toEqual([]);
    await expect(
      withTeam(app.db, teamB, (tx) => tx.insert(schedules).values(row(teamA))),
    ).rejects.toSatisfy((e) => pgCode(e) === "42501");
  });

  it("rejects an unknown paused_by and a blank prompt", async () => {
    await expect(
      withTeam(app.db, teamA, (tx) =>
        tx.insert(schedules).values({ ...row(teamA), pausedBy: "nobody" as "team_admin" }),
      ),
    ).rejects.toSatisfy((e) => pgCode(e) === "23514");
    await expect(
      withTeam(app.db, teamA, (tx) => tx.insert(schedules).values({ ...row(teamA), prompt: " " })),
    ).rejects.toSatisfy((e) => pgCode(e) === "23514");
  });

  it("rejects a fire without a schedule id or due time, so NULLs cannot dodge the index", async () => {
    const due = new Date("2031-01-01T08:00:00Z");
    const noId = { ...fire(teamA, randomUUID(), due), ref: {} };
    const noDue = { ...fire(teamA, randomUUID(), due), status: "pending" as const, dueAt: null };
    for (const bad of [noId, noDue]) {
      await expect(
        withTeam(app.db, teamA, (tx) => tx.insert(events).values(bad)),
      ).rejects.toSatisfy((e) => pgCode(e) === "23514");
    }
  });

  it("treats the schedule id case-insensitively", async () => {
    const due = new Date("2032-01-01T08:00:00Z");
    const sid = randomUUID();
    await withTeam(app.db, teamA, (tx) => tx.insert(events).values(fire(teamA, sid, due)));
    await expect(
      withTeam(app.db, teamA, (tx) =>
        tx.insert(events).values(fire(teamA, sid.toUpperCase(), due)),
      ),
    ).rejects.toSatisfy((e) => pgCode(e) === "23505");
  });

  it("rejects a duplicate (schedule_id, due_at) schedule.fire event", async () => {
    const due = new Date("2030-01-01T08:00:00Z");
    const sid = randomUUID();
    await withTeam(app.db, teamA, (tx) => tx.insert(events).values(fire(teamA, sid, due)));
    await expect(
      withTeam(app.db, teamA, (tx) => tx.insert(events).values(fire(teamA, sid, due))),
    ).rejects.toSatisfy((e) => pgCode(e) === "23505");
    // Another occurrence, another schedule, or another kind is fine.
    await withTeam(app.db, teamA, (tx) =>
      tx
        .insert(events)
        .values([
          fire(teamA, sid, new Date("2030-01-02T08:00:00Z")),
          fire(teamA, randomUUID(), due),
          { ...fire(teamA, sid, due), kind: "schedule.note" },
        ]),
    );
  });
});

describe("threads.schedule_id", () => {
  it("links a thread to its schedule, sets null on schedule delete, stays team-isolated", async () => {
    const sid = randomUUID();
    await withTeam(app.db, teamA, (tx) => tx.insert(schedules).values(row(teamA, sid)));
    const [t] = await withTeam(app.db, teamA, (tx) =>
      tx
        .insert(threads)
        .values({ teamId: teamA, ownerUserId: userId, scheduleId: sid })
        .returning(),
    );
    if (!t) throw new Error("thread insert returned nothing");
    expect(t.scheduleId).toBe(sid);
    expect(await withTeam(app.db, teamB, (tx) => tx.select().from(threads))).toEqual([]);
    await expect(
      withTeam(app.db, teamB, (tx) =>
        tx.insert(threads).values({ teamId: teamB, ownerUserId: userId, scheduleId: sid }),
      ),
    ).rejects.toSatisfy((e) => pgCode(e) === "23503");
    await withTeam(app.db, teamA, (tx) => tx.delete(schedules).where(eq(schedules.id, sid)));
    const [after] = await withTeam(app.db, teamA, (tx) =>
      tx.select().from(threads).where(eq(threads.id, t.id)),
    );
    expect(after).toMatchObject({ scheduleId: null, teamId: teamA });
  });
});

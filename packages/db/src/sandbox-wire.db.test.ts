import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { runs, sandboxCommands, sandboxRunLeases, teams, threads, users } from "./schema/index.js";
import { withTeam } from "./with-team.js";

/**
 * Sandbox wire schema (KOBE-24): the durable inbound cursor `runs.sandbox_seq` and the team-scoped
 * keys of the registry tables. RLS and the probe suite cover isolation (catalog/probe tests).
 */
const teamA = randomUUID();
const teamB = randomUUID();
let app: KobeDatabase;

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `sa-${teamA.slice(0, 8)}`, name: "Wire A" },
    { id: teamB, slug: `sb-${teamB.slice(0, 8)}`, name: "Wire B" },
  ]);
  await owner.close();
  app = createDb(inject("appUrl"), { max: 4 });
});

afterAll(() => app.close());

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("insert returned nothing");
  return value;
}

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (err === undefined) return undefined;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.cause?.code ?? e.code ?? String(err);
}

async function newRun(
  teamId: string,
): Promise<{ userId: string; threadId: string; runId: string }> {
  return withTeam(app.db, teamId, async (tx) => {
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: "W", email: `${userId}@wire.test` });
    const [thread] = await tx
      .insert(threads)
      .values({ teamId, ownerUserId: userId })
      .returning({ id: threads.id });
    const [run] = await tx
      .insert(runs)
      .values({
        teamId,
        threadId: must(thread).id,
        trigger: "user",
        status: "running",
        startedAt: new Date(),
      })
      .returning({ id: runs.id });
    return { userId, threadId: must(thread).id, runId: must(run).id };
  });
}

const cas = (teamId: string, runId: string, seq: number) =>
  withTeam(app.db, teamId, async (tx) => {
    const res = await tx.execute(sql`
      UPDATE runs SET sandbox_seq = ${seq}
       WHERE team_id = ${teamId} AND id = ${runId} AND sandbox_seq = ${seq - 1}`);
    return res.rowCount;
  });

describe("runs.sandbox_seq", () => {
  it("starts at 0 and advances by compare-and-set", async () => {
    const { runId } = await newRun(teamA);
    expect(await cas(teamA, runId, 1)).toBe(1);
    expect(await cas(teamA, runId, 1)).toBe(0); // duplicate
    expect(await cas(teamA, runId, 3)).toBe(0); // gap
    expect(await cas(teamA, runId, 2)).toBe(1);
  });

  it("never decreases", async () => {
    const { runId } = await newRun(teamA);
    await cas(teamA, runId, 1);
    await cas(teamA, runId, 2);
    const state = await sqlState(
      withTeam(app.db, teamA, (tx) =>
        tx.execute(sql`UPDATE runs SET sandbox_seq = 1 WHERE team_id = ${teamA} AND id = ${runId}`),
      ),
    );
    expect(state).toBe("23514");
  });

  it("is not visible to or writable by another team", async () => {
    const { runId } = await newRun(teamA);
    expect(await cas(teamB, runId, 1)).toBe(0);
    expect(await cas(teamA, runId, 1)).toBe(1);
  });
});

describe("registry tables", () => {
  it("rejects a lease in team A for team B's run", async () => {
    const b = await newRun(teamB);
    const state = await sqlState(
      withTeam(app.db, teamA, (tx) =>
        tx.insert(sandboxRunLeases).values({
          teamId: teamA,
          runId: b.runId,
          userId: b.userId,
          threadId: b.threadId,
          sandboxId: randomUUID(),
        }),
      ),
    );
    expect(state).toBe("23503");
  });

  it("cascades leases and commands away with their run and thread", async () => {
    const a = await newRun(teamA);
    await withTeam(app.db, teamA, async (tx) => {
      await tx.insert(sandboxRunLeases).values({
        teamId: teamA,
        runId: a.runId,
        userId: a.userId,
        threadId: a.threadId,
        sandboxId: randomUUID(),
      });
      await tx.insert(sandboxCommands).values({
        teamId: teamA,
        userId: a.userId,
        threadId: a.threadId,
        runId: a.runId,
        kind: "run.start",
        frame: { message: "x" },
        requesterReplica: "r1",
        expiresAt: new Date(Date.now() + 60_000),
      });
      await tx.execute(sql`DELETE FROM threads WHERE team_id = ${teamA} AND id = ${a.threadId}`);
      const left = await tx.execute<{ n: number }>(sql`
        SELECT (SELECT count(*) FROM sandbox_run_leases WHERE run_id = ${a.runId})::int
             + (SELECT count(*) FROM sandbox_commands WHERE thread_id = ${a.threadId})::int AS n`);
      expect(left.rows[0]?.n).toBe(0);
    });
  });

  it("refuses an unknown command kind and a delivered command without a connection", async () => {
    const a = await newRun(teamA);
    const base = {
      teamId: teamA,
      userId: a.userId,
      threadId: a.threadId,
      frame: {},
      requesterReplica: "r1",
      expiresAt: new Date(Date.now() + 60_000),
    };
    expect(
      await sqlState(
        withTeam(app.db, teamA, (tx) =>
          tx.insert(sandboxCommands).values({ ...base, kind: "bash" as "run.start" }),
        ),
      ),
    ).toBe("23514");
    expect(
      await sqlState(
        withTeam(app.db, teamA, (tx) =>
          tx.insert(sandboxCommands).values({ ...base, kind: "run.stop", status: "delivered" }),
        ),
      ),
    ).toBe("23514");
  });
});

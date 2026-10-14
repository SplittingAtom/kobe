import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { runs, sandboxCommands, teams, threads, users } from "./schema/index.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-213 (CE15): `runs.kind` tells a compaction run from a message run, and `sandbox_commands`
 * admits `thread.compact`. A compaction shares the thread's one-active-run lock; it never carries
 * a message, branch point, retry, client key or queue slot.
 */
const teamA = randomUUID();
const teamB = randomUUID();
let app: KobeDatabase;

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `ka-${teamA.slice(0, 8)}`, name: "Kind A" },
    { id: teamB, slug: `kb-${teamB.slice(0, 8)}`, name: "Kind B" },
  ]);
  await owner.close();
  app = createDb(inject("appUrl"), { max: 4 });
});

afterAll(() => app.close());

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (err === undefined) return undefined;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.cause?.code ?? e.code ?? String(err);
}

async function newThread(teamId: string): Promise<{ userId: string; threadId: string }> {
  return withTeam(app.db, teamId, async (tx) => {
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: "K", email: `${userId}@kind.test` });
    const [thread] = await tx
      .insert(threads)
      .values({ teamId, ownerUserId: userId })
      .returning({ id: threads.id });
    if (!thread) throw new Error("no thread");
    return { userId, threadId: thread.id };
  });
}

const running = { trigger: "user" as const, status: "running" as const, startedAt: new Date() };

const insertRun = (teamId: string, threadId: string, values: Record<string, unknown>) =>
  withTeam(app.db, teamId, async (tx) => {
    const [row] = await tx
      .insert(runs)
      .values({ teamId, threadId, trigger: "user", ...values })
      .returning({ id: runs.id, kind: runs.kind });
    return row;
  });

describe("runs.kind", () => {
  it("defaults to message, so a previous release's inserts stay message runs", async () => {
    const { threadId } = await newThread(teamA);
    const row = await withTeam(app.db, teamA, async (tx) => {
      await tx.execute(sql`
        INSERT INTO runs (team_id, thread_id, trigger, input) VALUES (${teamA}, ${threadId}, 'user', 'hi')`);
      const res = await tx.execute<{ kind: string }>(sql`
        SELECT kind FROM runs WHERE team_id = ${teamA} AND thread_id = ${threadId}`);
      return res.rows[0];
    });
    expect(row?.kind).toBe("message");
  });

  it("accepts a running compaction without input", async () => {
    const { threadId } = await newThread(teamA);
    const row = await insertRun(teamA, threadId, { ...running, kind: "compaction" });
    expect(row?.kind).toBe("compaction");
  });

  it("refuses an unknown kind", async () => {
    const { threadId } = await newThread(teamA);
    const state = await sqlState(
      insertRun(teamA, threadId, { ...running, kind: "summary" as "compaction" }),
    );
    expect(state).toBe("23514");
  });

  it.each([
    ["a message", { input: "hello" }],
    ["a branch point", { parentEntryId: "e1" }],
    ["a prompt entry", { userEntryId: "e2" }],
    ["a client key", { clientKey: "k1" }],
  ])("refuses a compaction with %s", async (_what, extra) => {
    const { threadId } = await newThread(teamA);
    const state = await sqlState(
      insertRun(teamA, threadId, { ...running, kind: "compaction", ...extra }),
    );
    expect(state).toBe("23514");
  });

  it("refuses a queued compaction", async () => {
    const { threadId } = await newThread(teamA);
    const state = await sqlState(
      insertRun(teamA, threadId, { kind: "compaction", status: "queued", queuePos: 1 }),
    );
    expect(state).toBe("23514");
  });

  it("refuses a compaction that retries a run", async () => {
    const { threadId } = await newThread(teamA);
    const first = await insertRun(teamA, threadId, {
      status: "interrupted",
      startedAt: new Date(),
      endedAt: new Date(),
      input: "x",
    });
    const state = await sqlState(
      insertRun(teamA, threadId, { ...running, kind: "compaction", retryOfRunId: first?.id }),
    );
    expect(state).toBe("23514");
  });

  it("shares the one-active-run lock with message runs", async () => {
    const { threadId } = await newThread(teamA);
    await insertRun(teamA, threadId, { ...running, input: "busy" });
    const state = await sqlState(insertRun(teamA, threadId, { ...running, kind: "compaction" }));
    expect(state).toBe("23505");
  });

  it("keeps a compaction run invisible to another team", async () => {
    const { threadId } = await newThread(teamA);
    const row = await insertRun(teamA, threadId, { ...running, kind: "compaction" });
    const seen = await withTeam(app.db, teamB, (tx) =>
      tx.execute(sql`SELECT 1 FROM runs WHERE id = ${row?.id ?? null}`),
    );
    expect(seen.rows).toHaveLength(0);
  });
});

describe("sandbox_commands.kind", () => {
  it("admits thread.compact", async () => {
    const { userId, threadId } = await newThread(teamA);
    const run = await insertRun(teamA, threadId, { ...running, kind: "compaction" });
    const state = await sqlState(
      withTeam(app.db, teamA, (tx) =>
        tx.insert(sandboxCommands).values({
          teamId: teamA,
          userId,
          threadId,
          runId: run?.id ?? null,
          kind: "thread.compact",
          frame: { thread_id: threadId },
          requesterReplica: "r1",
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    );
    expect(state).toBeUndefined();
  });
});

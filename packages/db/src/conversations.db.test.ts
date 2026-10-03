import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase, type KobeTx } from "./client.js";
import {
  events,
  runEvents,
  runs,
  teams,
  threadEntries,
  threads,
  users,
  type RunStatus,
} from "./schema/index.js";
import { withTeam } from "./with-team.js";

/**
 * Conversation schema integrity (KOBE-29): Pi tree mirroring, gapless per-run seq, one active run
 * per thread, and team-scoped foreign keys. Runs as the app role, through withTeam, like the server.
 */
const teamA = randomUUID();
const teamB = randomUUID();
let app: KobeDatabase;

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: teamA, slug: `ca-${teamA.slice(0, 8)}`, name: "Conv A" },
    { id: teamB, slug: `cb-${teamB.slice(0, 8)}`, name: "Conv B" },
  ]);
  await owner.close();
  app = createDb(inject("appUrl"), { max: 20 });
});

afterAll(() => app.close());

/** Postgres SQLSTATE of a rejected promise (drizzle wraps driver errors in `cause`). */
async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (err === undefined) return undefined;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.cause?.code ?? e.code ?? String(err);
}

async function errorMessage(promise: Promise<unknown>): Promise<string> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  const e = err as { message?: string; cause?: { message?: string } } | undefined;
  return `${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
}

async function insertThread(tx: KobeTx, teamId: string): Promise<string> {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, name: "Conv", email: `${userId}@conv.test` });
  const [row] = await tx
    .insert(threads)
    .values({ teamId, ownerUserId: userId })
    .returning({ id: threads.id });
  if (!row) throw new Error("thread insert returned nothing");
  return row.id;
}

async function insertRun(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  status: RunStatus = "running",
): Promise<string> {
  const startedAt = status === "queued" ? null : new Date();
  const endedAt = ["queued", "running", "waiting_approval"].includes(status) ? null : new Date();
  const [row] = await tx
    .insert(runs)
    .values({ teamId, threadId, trigger: "user", status, startedAt, endedAt })
    .returning({ id: runs.id });
  if (!row) throw new Error("run insert returned nothing");
  return row.id;
}

const newThread = (teamId: string): Promise<string> =>
  withTeam(app.db, teamId, (tx) => insertThread(tx, teamId));

const newRun = (teamId: string, threadId: string, status?: RunStatus): Promise<string> =>
  withTeam(app.db, teamId, (tx) => insertRun(tx, teamId, threadId, status));

function appendEvents(teamId: string, runId: string, n: number): Promise<number[]> {
  return withTeam(app.db, teamId, async (tx) => {
    const rows = await tx
      .insert(runEvents)
      .values(
        Array.from({ length: n }, (_, i) => ({
          teamId,
          runId,
          type: "text.delta",
          payload: { delta: `d${i}` },
        })),
      )
      .returning({ seq: runEvents.seq });
    return rows.map((r) => r.seq);
  });
}

function seqsOf(teamId: string, runId: string): Promise<number[]> {
  return withTeam(app.db, teamId, async (tx) => {
    const rows = await tx
      .select({ seq: runEvents.seq })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.seq));
    return rows.map((r) => r.seq);
  });
}

const oneTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

describe("run_events.seq (ac-4)", () => {
  it("numbers events 1..n per run, independently for each run", async () => {
    const thread = await newThread(teamA);
    const run1 = await newRun(teamA, thread, "completed");
    const run2 = await newRun(teamA, thread);
    expect(await appendEvents(teamA, run1, 3)).toEqual([1, 2, 3]);
    expect(await appendEvents(teamA, run2, 2)).toEqual([1, 2]);
    expect(await appendEvents(teamA, run1, 1)).toEqual([4]);
  });

  it("stays gapless and unique under concurrent appends", async () => {
    const run = await newRun(teamA, await newThread(teamA));
    await Promise.all(Array.from({ length: 25 }, () => appendEvents(teamA, run, 4)));
    expect(await seqsOf(teamA, run)).toEqual(oneTo(100));
  });

  it("leaves no gap when an append rolls back", async () => {
    const run = await newRun(teamA, await newThread(teamA));
    await appendEvents(teamA, run, 2);
    await expect(
      withTeam(app.db, teamA, async (tx) => {
        await tx.insert(runEvents).values({ teamId: teamA, runId: run, type: "text.delta" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await appendEvents(teamA, run, 1)).toEqual([3]);
  });

  it("never lets a reader see seq n+1 before seq n is visible", async () => {
    const run = await newRun(teamA, await newThread(teamA));
    let writing = true;
    const writers = Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        withTeam(app.db, teamA, async (tx) => {
          await tx.insert(runEvents).values({ teamId: teamA, runId: run, type: "text.delta" });
          // Hold the transaction open for a varying time so commits could interleave.
          await tx.execute(sql`SELECT pg_sleep(${(i % 4) * 0.02})`);
        }),
      ),
    ).finally(() => {
      writing = false;
    });
    const broken: number[][] = [];
    while (writing) {
      const seen = await seqsOf(teamA, run);
      if (seen.join() !== oneTo(seen.length).join()) broken.push(seen);
    }
    await writers;
    expect(broken).toEqual([]);
    expect(await seqsOf(teamA, run)).toEqual(oneTo(12));
  });

  it("rejects a caller-supplied seq", async () => {
    const run = await newRun(teamA, await newThread(teamA));
    const message = await errorMessage(
      withTeam(app.db, teamA, (tx) =>
        tx.insert(runEvents).values({ teamId: teamA, runId: run, seq: 7, type: "text.delta" }),
      ),
    );
    expect(message).toMatch(/assigned by the database/);
  });

  it("refuses to renumber an event", async () => {
    const run = await newRun(teamA, await newThread(teamA));
    await appendEvents(teamA, run, 2);
    const message = await errorMessage(
      withTeam(app.db, teamA, (tx) =>
        tx.update(runEvents).set({ seq: 9 }).where(eq(runEvents.runId, run)),
      ),
    );
    expect(message).toMatch(/cannot be changed/);
  });

  it("refuses to move an event to another run of the same team", async () => {
    const thread = await newThread(teamA);
    const r1 = await newRun(teamA, thread, "completed");
    const r2 = await newRun(teamA, thread);
    await appendEvents(teamA, r1, 1);
    await appendEvents(teamA, r2, 1);
    const message = await errorMessage(
      withTeam(app.db, teamA, (tx) =>
        tx.update(runEvents).set({ runId: r2 }).where(eq(runEvents.runId, r1)),
      ),
    );
    expect(message).toMatch(/cannot be changed/);
    expect(await seqsOf(teamA, r2)).toEqual([1]);
  });

  it("still allows updating an event's payload", async () => {
    const run = await newRun(teamA, await newThread(teamA));
    await appendEvents(teamA, run, 1);
    await withTeam(app.db, teamA, (tx) =>
      tx
        .update(runEvents)
        .set({ payload: { edited: true } })
        .where(eq(runEvents.runId, run)),
    );
  });

  it.each([
    ["sets it back", 0],
    ["skips ahead", 50],
    ["bumps it directly", 3],
  ])("refuses an app write to runs.last_seq that %s", async (_label, value) => {
    const run = await newRun(teamA, await newThread(teamA));
    await appendEvents(teamA, run, 2);
    const message = await errorMessage(
      withTeam(app.db, teamA, (tx) =>
        tx.update(runs).set({ lastSeq: value }).where(eq(runs.id, run)),
      ),
    );
    expect(message).toMatch(/maintained by the database/);
    expect(await appendEvents(teamA, run, 1)).toEqual([3]);
  });

  it("rejects an event for a run that does not exist", async () => {
    const state = await sqlState(appendEvents(teamA, randomUUID(), 1));
    expect(state).toBeDefined();
  });
});

describe("thread_entries mirror the Pi session tree (ac-3)", () => {
  function insertEntry(
    teamId: string,
    threadId: string,
    entryId: string,
    parentId: string | null,
  ): Promise<number> {
    return withTeam(app.db, teamId, async (tx) => {
      const [row] = await tx
        .insert(threadEntries)
        .values({ teamId, threadId, entryId, parentId, type: "message", payload: { entryId } })
        .returning({ seq: threadEntries.seq });
      if (!row) throw new Error("entry insert returned nothing");
      return row.seq;
    });
  }

  it("numbers entries per thread in insertion order and supports branches", async () => {
    const thread = await newThread(teamA);
    expect(await insertEntry(teamA, thread, "e1", null)).toBe(1);
    expect(await insertEntry(teamA, thread, "e2", "e1")).toBe(2);
    expect(await insertEntry(teamA, thread, "e2b", "e1")).toBe(3);
    const other = await newThread(teamA);
    expect(await insertEntry(teamA, other, "e1", null)).toBe(1);
  });

  it("rejects a parent that is not an entry of the same thread", async () => {
    const t1 = await newThread(teamA);
    const t2 = await newThread(teamA);
    await insertEntry(teamA, t1, "root", null);
    expect(await sqlState(insertEntry(teamA, t2, "child", "root"))).toBe("23503");
  });

  it("refuses to move an entry to another thread", async () => {
    const t1 = await newThread(teamA);
    const t2 = await newThread(teamA);
    await insertEntry(teamA, t1, "m", null);
    const message = await errorMessage(
      withTeam(app.db, teamA, (tx) =>
        tx.update(threadEntries).set({ threadId: t2 }).where(eq(threadEntries.threadId, t1)),
      ),
    );
    expect(message).toMatch(/cannot be changed/);
  });

  it("refuses to renumber an entry or rewrite the thread's entry counter", async () => {
    const thread = await newThread(teamA);
    await insertEntry(teamA, thread, "r", null);
    const renumber = await errorMessage(
      withTeam(app.db, teamA, (tx) =>
        tx.update(threadEntries).set({ seq: 5 }).where(eq(threadEntries.threadId, thread)),
      ),
    );
    expect(renumber).toMatch(/cannot be changed/);
    const counter = await errorMessage(
      withTeam(app.db, teamA, (tx) =>
        tx.update(threads).set({ lastEntrySeq: 0 }).where(eq(threads.id, thread)),
      ),
    );
    expect(counter).toMatch(/maintained by the database/);
    expect(await insertEntry(teamA, thread, "r2", "r")).toBe(2);
  });

  it("rejects a duplicate entry id within a thread", async () => {
    const thread = await newThread(teamA);
    await insertEntry(teamA, thread, "dup", null);
    expect(await sqlState(insertEntry(teamA, thread, "dup", null))).toBe("23505");
  });

  it("only accepts a leaf that is an entry of the thread", async () => {
    const t1 = await newThread(teamA);
    const t2 = await newThread(teamA);
    await insertEntry(teamA, t1, "leaf", null);
    await insertEntry(teamA, t2, "elsewhere", null);
    await withTeam(app.db, teamA, (tx) =>
      tx.update(threads).set({ leafEntryId: "leaf" }).where(eq(threads.id, t1)),
    );
    const state = await sqlState(
      withTeam(app.db, teamA, (tx) =>
        tx.update(threads).set({ leafEntryId: "elsewhere" }).where(eq(threads.id, t1)),
      ),
    );
    expect(state).toBe("23503");
  });

  it("hard-deletes a thread with its entries, runs and run events", async () => {
    const thread = await newThread(teamA);
    await insertEntry(teamA, thread, "a", null);
    await insertEntry(teamA, thread, "b", "a");
    await withTeam(app.db, teamA, (tx) =>
      tx.update(threads).set({ leafEntryId: "b" }).where(eq(threads.id, thread)),
    );
    const run = await newRun(teamA, thread, "completed");
    await appendEvents(teamA, run, 2);
    await withTeam(app.db, teamA, (tx) => tx.delete(threads).where(eq(threads.id, thread)));
    const left = await withTeam(app.db, teamA, async (tx) => ({
      entries: await tx.$count(threadEntries, eq(threadEntries.threadId, thread)),
      runs: await tx.$count(runs, eq(runs.threadId, thread)),
      events: await tx.$count(runEvents, eq(runEvents.runId, run)),
    }));
    expect(left).toEqual({ entries: 0, runs: 0, events: 0 });
  });
});

describe("runs (ac-5)", () => {
  it("allows one active run per thread but any number of queued runs", async () => {
    const thread = await newThread(teamA);
    await newRun(teamA, thread, "running");
    await newRun(teamA, thread, "queued");
    await newRun(teamA, thread, "queued");
    expect(await sqlState(newRun(teamA, thread, "running"))).toBe("23505");
    expect(await sqlState(newRun(teamA, thread, "waiting_approval"))).toBe("23505");
  });

  it("allows a new active run once the previous one ended", async () => {
    const thread = await newThread(teamA);
    const first = await newRun(teamA, thread, "running");
    await withTeam(app.db, teamA, (tx) =>
      tx
        .update(runs)
        .set({ status: "completed", endedAt: new Date() })
        .where(and(eq(runs.id, first))),
    );
    expect(await sqlState(newRun(teamA, thread, "running"))).toBeUndefined();
  });

  it("requires ended_at exactly for ended runs", async () => {
    const thread = await newThread(teamA);
    const run = await newRun(teamA, thread, "running");
    const noEnd = await sqlState(
      withTeam(app.db, teamA, (tx) =>
        tx.update(runs).set({ status: "failed" }).where(eq(runs.id, run)),
      ),
    );
    expect(noEnd).toBe("23514");
    const endWhileRunning = await sqlState(
      withTeam(app.db, teamA, (tx) =>
        tx.update(runs).set({ endedAt: new Date() }).where(eq(runs.id, run)),
      ),
    );
    expect(endWhileRunning).toBe("23514");
  });

  it("keeps queue_pos for queued runs only", async () => {
    const thread = await newThread(teamA);
    const state = await sqlState(
      withTeam(app.db, teamA, (tx) =>
        tx.insert(runs).values({
          teamId: teamA,
          threadId: thread,
          trigger: "user",
          status: "running",
          startedAt: new Date(),
          queuePos: 1,
        }),
      ),
    );
    expect(state).toBe("23514");
  });
});

describe("runs: queue and compaction", () => {
  function queued(threadId: string, queuePos: number): Promise<unknown> {
    return withTeam(app.db, teamA, (tx) =>
      tx.insert(runs).values({ teamId: teamA, threadId, trigger: "user", queuePos }),
    );
  }

  it("keeps queue positions unique among a thread's queued runs", async () => {
    const thread = await newThread(teamA);
    await queued(thread, 1);
    await queued(thread, 2);
    expect(await sqlState(queued(thread, 1))).toBe("23505");
    expect(await sqlState(queued(await newThread(teamA), 1))).toBeUndefined();
  });

  it("marks compaction only on ended runs", async () => {
    const thread = await newThread(teamA);
    const running = await newRun(teamA, thread);
    const state = await sqlState(
      withTeam(app.db, teamA, (tx) =>
        tx.update(runs).set({ eventsCompactedAt: new Date() }).where(eq(runs.id, running)),
      ),
    );
    expect(state).toBe("23514");
    const ended = await newRun(teamA, thread, "completed");
    await withTeam(app.db, teamA, (tx) =>
      tx.update(runs).set({ eventsCompactedAt: new Date() }).where(eq(runs.id, ended)),
    );
  });
});

describe("runs: orchestrator columns (KOBE-30)", () => {
  const insert = (threadId: string, values: Partial<typeof runs.$inferInsert>) =>
    withTeam(app.db, teamA, (tx) =>
      tx
        .insert(runs)
        .values({ teamId: teamA, threadId, trigger: "user", queuePos: 1, ...values })
        .returning({ id: runs.id }),
    );

  it("allows at most one retry per run, of a run in the same team", async () => {
    const thread = await newThread(teamA);
    const original = await newRun(teamA, thread, "interrupted");
    expect(await sqlState(insert(thread, { retryOfRunId: original }))).toBeUndefined();
    expect(await sqlState(insert(await newThread(teamA), { retryOfRunId: original }))).toBe(
      "23505",
    );
    const foreign = await newRun(teamB, await newThread(teamB), "interrupted");
    expect(await sqlState(insert(await newThread(teamA), { retryOfRunId: foreign }))).toBe("23503");
  });

  it("checks the approval mode, budget scope, entry ids and input length", async () => {
    const thread = await newThread(teamA);
    expect(await sqlState(insert(thread, { approvalMode: "bypass" as "auto" }))).toBe("23514");
    expect(await sqlState(insert(thread, { budgetStopScope: "org" as "team" }))).toBe("23514");
    expect(await sqlState(insert(thread, { parentEntryId: "" }))).toBe("23514");
    expect(await sqlState(insert(thread, { input: "x".repeat(200_001) }))).toBe("23514");
    expect(
      await sqlState(insert(thread, { approvalMode: "ask-all", input: "hi", parentEntryId: "e1" })),
    ).toBeUndefined();
  });
});

describe("events", () => {
  it("requires due_at for scheduled events", async () => {
    const state = await sqlState(
      withTeam(app.db, teamA, (tx) =>
        tx.insert(events).values({ teamId: teamA, kind: "schedule.fired", status: "scheduled" }),
      ),
    );
    expect(state).toBe("23514");
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(events).values({
        teamId: teamA,
        kind: "schedule.fired",
        status: "scheduled",
        dueAt: new Date(Date.now() + 60_000),
      }),
    );
  });
});

describe("team-scoped foreign keys (ac-6)", () => {
  // FK checks and cascades bypass RLS; foreign keys that include team_id keep them in one team.
  it("rejects an entry in team A that points at team B's thread", async () => {
    const threadB = await newThread(teamB);
    const state = await sqlState(
      withTeam(app.db, teamA, (tx) =>
        tx.insert(threadEntries).values({
          teamId: teamA,
          threadId: threadB,
          entryId: "x",
          type: "message",
          payload: {},
        }),
      ),
    );
    expect(state).toBe("23503");
  });

  it("rejects a run in team A for team B's thread", async () => {
    const threadB = await newThread(teamB);
    expect(await sqlState(newRun(teamA, threadB))).toBe("23503");
  });

  it("rejects a run event in team A for team B's run", async () => {
    const runB = await newRun(teamB, await newThread(teamB));
    expect(await sqlState(appendEvents(teamA, runB, 1))).toBeDefined();
    expect(await seqsOf(teamB, runB)).toEqual([]);
  });
});

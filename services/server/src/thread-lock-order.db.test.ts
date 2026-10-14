import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type KobeTx } from "@kobe/db";
import { appendRunEventsInTx, withAppendTx } from "./event-stream/append.js";
import { reorderQueuedRuns } from "./runs/queue-order.js";
import { lockRunRow, lockThreadRow } from "./runs/store.js";
import { findThread } from "./threads/repository.js";
import { EventStreamFixture, delta, must, type Person } from "./testing/event-stream-fixture.js";

/**
 * KOBE-266: the thread lock must not deadlock with a run's own event writer.
 *
 * The ingest (and every appender) updates the run row and then inserts `run_events`, whose seq
 * trigger updates the run row again. Postgres re-checks a row's foreign keys on an UPDATE when the
 * row version was written by the same transaction, so that second update takes FOR KEY SHARE on
 * the run's thread row (runs.thread_id → threads) while the run row is already held: run, then
 * thread. A status writer (approval broker, decide, Stop, sweeps) locks the thread and then the
 * run. With the thread lock in FOR UPDATE, which conflicts with FOR KEY SHARE, the two wait on each
 * other and Postgres aborts one with 40P01 — in CI the approval broker's, so `share_file` was
 * denied ("Policy could not be evaluated"). The thread lock is FOR NO KEY UPDATE: still exclusive
 * among thread lockers, and it no longer conflicts with foreign-key checks.
 */
const fx = new EventStreamFixture();
let owner: Person;
let team: string;

beforeAll(async () => {
  await fx.setup([{}]);
  owner = await fx.person("lockorder");
  team = await fx.team(`lockorder-${Date.now()}`, owner);
});

afterAll(async () => {
  await fx.teardown();
});

async function threadOf(runId: string): Promise<string> {
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  return must(rows[0], "run").thread_id;
}

/** Resolves once a backend of this test database waits on a lock in a statement matching `like`. */
async function waitingOnLock(like: string): Promise<void> {
  await expect
    .poll(async () => {
      const { rows } = await fx.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        [like],
      );
      return rows[0]?.n ?? 0;
    })
    .toBeGreaterThan(0);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** "fulfilled", or the Postgres code (40P01: deadlock) and message of the rejection. */
function why(result: PromiseSettledResult<unknown>): string {
  if (result.status === "fulfilled") return "fulfilled";
  const err = result.reason as { message?: string; cause?: { code?: string; message?: string } };
  return `rejected ${err.cause?.code ?? "-"} ${err.cause?.message ?? err.message ?? ""}`;
}

type ThreadLock = (tx: KobeTx, threadId: string) => Promise<unknown>;

const THREAD_LOCKS: readonly (readonly [string, ThreadLock])[] = [
  ["lockThreadRow (broker, decide, sweeps)", (tx, id) => lockThreadRow(tx, team, id)],
  [
    "findThread with lock (owner's changes, Stop)",
    (tx, id) =>
      findThread(tx, { teamId: team, userId: owner.id, projectIds: [] }, id, { lock: true }),
  ],
];

describe("thread lock vs. the run's event writer (KOBE-266)", () => {
  it.each(THREAD_LOCKS)(
    "%s, then the run row, while an appender holds the run: both commit, no deadlock",
    async (_name, lockThread) => {
      const runId = await fx.run(team, owner);
      const threadId = await threadOf(runId);
      const runHeld = deferred();
      const statusWriterWaits = deferred();

      // The ingest's shape (ingest.ts #flush without an entry sync): cursor update, then events.
      const appender = withAppendTx(fx.db, team, async (tx) => {
        await tx.execute(sql`
          UPDATE runs SET sandbox_bytes = sandbox_bytes + 1 WHERE team_id = ${team} AND id = ${runId}`);
        runHeld.resolve();
        await statusWriterWaits.promise;
        return appendRunEventsInTx(tx, team, runId, [delta("a"), delta("b")]);
      });

      // The approval broker's shape (#create): thread, then run.
      const statusWriter = (async () => {
        await runHeld.promise;
        return withAppendTx(fx.db, team, async (tx) => {
          await lockThread(tx, threadId);
          return lockRunRow(tx, team, runId);
        });
      })();

      await waitingOnLock("%FROM runs WHERE team_id = % FOR NO KEY UPDATE%");
      statusWriterWaits.resolve();

      const [appended, locked] = await Promise.allSettled([appender, statusWriter]);
      expect(why(appended)).toBe("fulfilled");
      expect(why(locked)).toBe("fulfilled");
      expect(await fx.seqsInDb(team, runId)).toEqual([1, 2]);
    },
  );
});

describe("the thread lock is still the per-thread mutex (D17)", () => {
  it("a second thread locker waits for the first (here: until its lock timeout)", async () => {
    const runId = await fx.run(team, owner);
    const threadId = await threadOf(runId);
    const held = deferred();
    const release = deferred();
    const first = withAppendTx(fx.db, team, async (tx) => {
      await lockThreadRow(tx, team, threadId);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const second = await Promise.allSettled([
      withAppendTx(fx.db, team, async (tx) => {
        await tx.execute(sql`SELECT set_config('lock_timeout', '200ms', true)`);
        await findThread(tx, { teamId: team, userId: owner.id, projectIds: [] }, threadId, {
          lock: true,
        });
      }),
    ]);
    release.resolve();
    await first;
    expect(why(must(second[0], "second"))).toMatch(/^rejected 55P03 /);
  });
});

describe("queue reorder vs. foreign-key checks (KOBE-266 review)", () => {
  it("a reorder holding the queued runs does not block a KEY SHARE on them", async () => {
    const runId = await fx.run(team, owner);
    const threadId = await threadOf(runId);
    const { rows } = await fx.admin.query<{ id: string }>(
      `INSERT INTO runs (team_id, thread_id, trigger, status, queue_pos, input)
       SELECT $1, $2, 'user', 'queued', n, 'q' FROM generate_series(1, 2) n RETURNING id`,
      [team, threadId],
    );
    const queued = rows.map((r) => r.id);
    const held = deferred();
    const release = deferred();
    const reorder = withAppendTx(fx.db, team, async (tx) => {
      await reorderQueuedRuns(tx, team, threadId, [...queued].reverse());
      held.resolve();
      await release.promise;
    });
    await held.promise;
    // What a foreign-key check on a run takes (e.g. inserting one of its child rows).
    const keyShare = await Promise.allSettled([
      withAppendTx(fx.db, team, async (tx) => {
        await tx.execute(sql`SELECT set_config('lock_timeout', '200ms', true)`);
        await tx.execute(sql`
          SELECT 1 FROM runs WHERE team_id = ${team} AND id = ${must(queued[0], "run")} FOR KEY SHARE`);
      }),
    ]);
    release.resolve();
    await reorder;
    expect(why(must(keyShare[0], "key share"))).toBe("fulfilled");
  });
});

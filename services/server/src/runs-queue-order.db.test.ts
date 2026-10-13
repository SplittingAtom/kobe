import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { threadRunsSchema } from "./openapi/runs.js";
import { must } from "./testing/event-stream-fixture.js";
import { RunFixture, type FakeWorkspace, type RunWorld } from "./testing/run-fixture.js";

/**
 * Reordering the queue (CE10, KOBE-206): `POST /v1/threads/{id}/queue/order`. Owner only, the ids
 * must be exactly the queued set, and the thread row lock keeps a run start from interleaving.
 * Real Postgres, real wire, two replicas.
 */
const f = new RunFixture();

beforeAll(async () => {
  await f.setup();
});

afterAll(async () => {
  await f.teardown();
});

/** A thread with a running first message and `queued` more behind it. */
async function busyThread(w: RunWorld, ws: FakeWorkspace, queued: number) {
  const threadId = await f.thread(w.owner);
  const active = await f.message(w.owner, threadId, "first");
  await ws.started(active);
  const waiting: string[] = [];
  for (let i = 0; i < queued; i += 1) {
    waiting.push(await f.message(w.owner, threadId, `queued ${i + 1}`));
  }
  return { threadId, active, waiting };
}

const order = (w: RunWorld, threadId: string, runIds: readonly string[], replica = 0) =>
  f.on(replica, w.owner).post(`/v1/threads/${threadId}/queue/order`, { run_ids: runIds });

async function queuePositions(team: string, threadId: string) {
  const { rows } = await f.fx.admin.query<{ id: string; queue_pos: number }>(
    `SELECT id, queue_pos FROM runs
      WHERE team_id = $1 AND thread_id = $2 AND status = 'queued' ORDER BY queue_pos`,
    [team, threadId],
  );
  return rows;
}

describe("queue order", () => {
  it("applies the new order: positions 1..n, the next start follows it", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 0);
    const { threadId, active, waiting } = await busyThread(w, ws, 3);
    const [q1, q2, q3] = waiting as [string, string, string];

    const res = await order(w, threadId, [q3, q1, q2], 1);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const runs = threadRunsSchema.parse(res.json).runs;
    expect(runs.map((r) => [r.run_id, r.queue_pos ?? null])).toEqual([
      [active, null],
      [q3, 1],
      [q1, 2],
      [q2, 3],
    ]);
    expect(await queuePositions(w.team, threadId)).toEqual([
      { id: q3, queue_pos: 1 },
      { id: q1, queue_pos: 2 },
      { id: q2, queue_pos: 3 },
    ]);

    // A message sent afterwards joins the end.
    const q4 = await f.message(w.owner, threadId, "queued 4");
    expect((await f.run(w.team, q4)).queue_pos).toBe(4);

    ws.reply(await ws.started(active), "done");
    await f.until(w.team, active, "completed");
    ws.reply(await ws.started(q3), "three");
    await f.until(w.team, q3, "completed");
    expect(ws.starts().map((s) => s.run_id)).toEqual([active, q3]);
    expect(await auditTargets(w.team, "run.queue_reordered")).toEqual([{ threadId, queued: 3 }]);
  });

  it("refuses a stale or partial set with 409 queue_changed and changes nothing", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 0);
    const { threadId, active, waiting } = await busyThread(w, ws, 2);
    const [q1, q2] = waiting as [string, string];
    const before = await queuePositions(w.team, threadId);

    for (const ids of [[q2], [q2, q1, active], [q2, active]]) {
      const res = await order(w, threadId, ids);
      expect(res.status, JSON.stringify(ids)).toBe(409);
      expect(res.json.code).toBe("queue_changed");
    }
    // A deleted message: the client's list is stale.
    await f.on(0, w.owner).post(`/v1/runs/${q1}/cancel`);
    const stale = await order(w, threadId, [q2, q1]);
    expect(stale.json.code).toBe("queue_changed");
    expect(await queuePositions(w.team, threadId)).toEqual(before.filter((r) => r.id !== q1));
  });

  it("validates the body: UUIDs, no repeats, at most the queue cap", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 0);
    const { threadId, waiting } = await busyThread(w, ws, 1);
    const [q1] = waiting as [string];
    const ids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());
    for (const body of [
      {},
      { run_ids: [] },
      { run_ids: ["nope"] },
      { run_ids: [q1, q1] },
      { run_ids: ids(101) },
      { run_ids: [q1], extra: true },
    ]) {
      const res = await f.on(0, w.owner).post(`/v1/threads/${threadId}/queue/order`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    // Past the queue cap (a Retry may queue past it) the exact-set check decides: 409, not 400.
    const many = await order(w, threadId, ids(26));
    expect([many.status, many.json.code]).toEqual([409, "queue_changed"]);
  });

  it("refuses a thread in Trash on both routes (409 thread_in_trash)", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    expect((await f.on(0, w.owner).delete(`/v1/threads/${threadId}`)).status).toBe(200);
    const ordered = await order(w, threadId, [crypto.randomUUID()]);
    expect([ordered.status, ordered.json.code]).toEqual([409, "thread_in_trash"]);
    const paused = await f.on(0, w.owner).post(`/v1/threads/${threadId}/queue/pause`);
    expect([paused.status, paused.json.code]).toEqual([409, "thread_in_trash"]);
  });

  it("only the owner reorders: a team member and another team get 404", async () => {
    const w = await f.world(1);
    const ws = await f.connect(w, 0);
    const { threadId, waiting } = await busyThread(w, ws, 2);
    const [q1, q2] = waiting as [string, string];
    const before = await queuePositions(w.team, threadId);

    const member = await f
      .on(0, must(w.others[0], "member"))
      .post(`/v1/threads/${threadId}/queue/order`, {
        run_ids: [q2, q1],
      });
    expect(member.status).toBe(404);
    expect(member.json.code).toBe("thread_not_found");

    const other = await f.world();
    const foreign = await f.on(0, other.owner).post(`/v1/threads/${threadId}/queue/order`, {
      run_ids: [q2, q1],
    });
    expect(foreign.status).toBe(404);
    expect(await queuePositions(w.team, threadId)).toEqual(before);
  });

  it("a run start racing a reorder: either the start sees the new order, or the reorder is refused", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 0);
    const { threadId, active, waiting } = await busyThread(w, ws, 3);
    const [q1, q2, q3] = waiting as [string, string, string];
    const start = await ws.started(active);

    // The active run ends (promoting the head of the queue) while the reorder is in flight.
    const [res] = await Promise.all([order(w, threadId, [q3, q2, q1], 1), ws.reply(start, "done")]);
    await f.until(w.team, active, "completed");
    const next = await ws.started(res.status === 200 ? q3 : q1);
    if (res.status === 200) {
      expect(next.run_id).toBe(q3);
      expect(await queuePositions(w.team, threadId)).toEqual([
        { id: q2, queue_pos: 2 },
        { id: q1, queue_pos: 3 },
      ]);
    } else {
      expect(res.json.code).toBe("queue_changed");
      expect(next.run_id).toBe(q1);
    }
    // Never two at once, and positions stay unique.
    const positions = (await queuePositions(w.team, threadId)).map((r) => r.queue_pos);
    expect(new Set(positions).size).toBe(positions.length);
  });
});

async function auditTargets(team: string, action: string) {
  const { rows } = await f.fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
    [team, action],
  );
  return rows.map((r) => r.target);
}

const pause = (w: RunWorld, threadId: string, replica = 0) =>
  f.on(replica, w.owner).post(`/v1/threads/${threadId}/queue/pause`);

describe("queue pause", () => {
  it("holds the queue past the active run's end until resumed, and audits both", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 0);
    const { threadId, active, waiting } = await busyThread(w, ws, 2);
    const [q1] = waiting as [string, string];

    const res = await pause(w, threadId, 1);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(threadRunsSchema.parse(res.json).queue_paused).toBe(true);
    expect((await pause(w, threadId)).status).toBe(200); // idempotent
    expect(await auditTargets(w.team, "run.queue_paused")).toEqual([{ threadId, queued: 2 }]);

    ws.reply(await ws.started(active), "done");
    await f.until(w.team, active, "completed");
    for (let i = 0; i < 2; i += 1) {
      await f.fx.replica(i).deps.runs.idle();
      await f.fx.replica(i).deps.runs.sweep();
      await f.fx.replica(i).deps.runs.idle();
    }
    expect(await f.status(w.team, q1)).toBe("queued");
    expect(ws.starts().map((s) => s.run_id)).toEqual([active]);

    const resumed = await f.on(0, w.owner).post(`/v1/threads/${threadId}/queue/resume`);
    expect(threadRunsSchema.parse(resumed.json).queue_paused).toBe(false);
    ws.reply(await ws.started(q1), "one");
    await f.until(w.team, q1, "completed");
    expect(await auditTargets(w.team, "run.queue_resumed")).toEqual([
      { threadId, wasInterrupted: false },
    ]);
  });

  it("does nothing with nothing queued; a new message releases a paused queue", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 0);
    const empty = await busyThread(w, ws, 0);
    const none = await pause(w, empty.threadId);
    expect(threadRunsSchema.parse(none.json).queue_paused).toBe(false);
    expect(await auditTargets(w.team, "run.queue_paused")).toEqual([]);

    const busy = await busyThread(w, ws, 1);
    await pause(w, busy.threadId);
    const sent = await f.send(w.owner, busy.threadId, "one more");
    expect(sent.json.queued).toBe(true);
    const runs = await f.on(0, w.owner).get(`/v1/threads/${busy.threadId}/runs`);
    expect(threadRunsSchema.parse(runs.json).queue_paused).toBe(false);
  });

  it("only the owner pauses: a team member and another team get 404", async () => {
    const w = await f.world(1);
    const ws = await f.connect(w, 0);
    const { threadId } = await busyThread(w, ws, 1);
    const member = await f
      .on(0, must(w.others[0], "member"))
      .post(`/v1/threads/${threadId}/queue/pause`);
    expect(member.status).toBe(404);
    const other = await f.world();
    const foreign = await f.on(0, other.owner).post(`/v1/threads/${threadId}/queue/pause`);
    expect(foreign.status).toBe(404);
    const runs = await f.on(0, w.owner).get(`/v1/threads/${threadId}/runs`);
    expect(threadRunsSchema.parse(runs.json).queue_paused).toBe(false);
  });
});

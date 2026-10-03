import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { threadRunsSchema } from "./openapi/runs.js";
import { RunFixture, type FakeWorkspace, type RunWorld } from "./testing/run-fixture.js";

/**
 * Stop pauses the queue (KOBE-26, decided by Chris): after Stop of the active run, the messages
 * queued behind it wait until the user resumes the queue or sends a new message. Real Postgres,
 * real wire, two replicas.
 */
const f = new RunFixture();

beforeAll(async () => {
  await f.setup();
});

afterAll(async () => {
  await f.teardown();
});

/** Lets every background promotion, grace timer and sweep run, so nothing starts later. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400)); // > stopGraceMs (300) in the fixture
  for (let i = 0; i < 2; i += 1) {
    await f.fx.replica(i).deps.runs.idle();
    await f.fx.replica(i).deps.runs.sweep();
    await f.fx.replica(i).deps.runs.idle();
  }
}

async function threadRuns(w: RunWorld, threadId: string, replica = 0) {
  const res = await f.on(replica, w.owner).get(`/v1/threads/${threadId}/runs`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return threadRunsSchema.parse(res.json);
}

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

describe("Stop pauses the queue", () => {
  it("starts none of the queued messages until the user resumes, then runs them in order", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 0);
    const { threadId, active, waiting } = await busyThread(w, ws, 2);
    const [q1, q2] = waiting as [string, string];

    const stop = await f.on(1, w.owner).post(`/v1/runs/${active}/cancel`);
    expect(stop.json.status).toBe("cancelled");
    await settle();
    expect(await f.status(w.team, q1)).toBe("queued");
    expect(await f.status(w.team, q2)).toBe("queued");
    expect(ws.starts().map((s) => s.run_id)).toEqual([active]);
    expect(await f.threadStatus(w.team, threadId)).toBe("idle");
    const paused = await threadRuns(w, threadId, 1);
    expect(paused.queue_paused).toBe(true);
    expect(paused.interrupted_run).toBeNull();
    const { rows } = await f.fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'run.cancelled'`,
      [w.team],
    );
    expect(rows.map((r) => r.target)).toEqual([
      { runId: active, threadId, wasActive: true, queuePaused: true },
    ]);

    const resumed = await f.on(0, w.owner).post(`/v1/threads/${threadId}/queue/resume`);
    expect(resumed.status).toBe(200);
    expect(threadRunsSchema.parse(resumed.json).queue_paused).toBe(false);
    ws.reply(await ws.started(q1), "one");
    await f.until(w.team, q1, "completed");
    ws.reply(await ws.started(q2), "two");
    await f.until(w.team, q2, "completed");
    expect(ws.starts().map((s) => s.run_id)).toEqual([active, q1, q2]);
  });

  it("a new message releases the paused queue: it joins the end and the earlier ones run first", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 0);
    const { threadId, active, waiting } = await busyThread(w, ws, 1);
    const [q1] = waiting as [string];
    await f.on(0, w.owner).post(`/v1/runs/${active}/cancel`);
    await settle();
    expect(await f.status(w.team, q1)).toBe("queued");

    const sent = await f.send(w.owner, threadId, "and now this", 1);
    expect(sent.status).toBe(201);
    expect(sent.json.queued).toBe(true);
    const next = sent.json.run_id as string;
    ws.reply(await ws.started(q1), "one");
    await f.until(w.team, q1, "completed");
    ws.reply(await ws.started(next), "two");
    await f.until(w.team, next, "completed");
    expect((await threadRuns(w, threadId)).queue_paused).toBe(false);
  });

  it("does not pause when nothing is queued, or when a queued message is deleted", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 0);
    // Stop with an empty queue: the next message starts at once.
    const alone = await busyThread(w, ws, 0);
    await f.on(0, w.owner).post(`/v1/runs/${alone.active}/cancel`);
    await settle();
    expect((await threadRuns(w, alone.threadId)).queue_paused).toBe(false);
    const sent = await f.send(w.owner, alone.threadId, "again");
    expect(sent.json.queued).toBe(false);
    ws.reply(await ws.started(sent.json.run_id as string), "ok");
    await f.until(w.team, sent.json.run_id as string, "completed");

    // Deleting a queued message is not a Stop: the queue keeps moving.
    const busy = await busyThread(w, ws, 2);
    const [q1, q2] = busy.waiting as [string, string];
    await f.on(0, w.owner).post(`/v1/runs/${q1}/cancel`);
    ws.reply(await ws.started(busy.active), "done");
    await f.until(w.team, busy.active, "completed");
    ws.reply(await ws.started(q2), "next");
    await f.until(w.team, q2, "completed");
    expect((await threadRuns(w, busy.threadId)).queue_paused).toBe(false);
  });

  it("Stop of a retry pauses too; resume clears it; an interrupted thread still needs Retry or Continue", async () => {
    const w = await f.world();
    let ws = await f.connect(w, 0);
    const { threadId, active, waiting } = await busyThread(w, ws, 1);
    const [q1] = waiting as [string];
    ws.reply(await ws.started(active), "half", false);
    await ws.acked(active);
    ws.kill();
    await ws.sb.waitClosed();
    await expect
      .poll(async () => {
        await f.fx.replica(1).deps.sandboxWire.sweep();
        return f.status(w.team, active);
      })
      .toBe("interrupted");
    // Interrupted: held (not "paused") until Retry or Continue.
    let state = await threadRuns(w, threadId);
    expect(state.interrupted_run?.run_id).toBe(active);
    expect(state.queue_paused).toBe(false);
    ws = await f.connect(w, 1);
    const retry = await f.on(0, w.owner).post(`/v1/runs/${active}/retry`);
    const retryId = retry.json.run_id as string;
    await ws.started(retryId);
    await f.on(0, w.owner).post(`/v1/runs/${retryId}/cancel`);
    await settle();
    expect(await f.status(w.team, q1)).toBe("queued");
    state = await threadRuns(w, threadId);
    expect(state.queue_paused).toBe(true);
    await f.on(0, w.owner).post(`/v1/threads/${threadId}/queue/resume`);
    ws.reply(await ws.started(q1), "one");
    await f.until(w.team, q1, "completed");
  });
});

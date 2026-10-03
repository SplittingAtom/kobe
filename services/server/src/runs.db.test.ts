import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSnapshotSchema, submitMessageResultSchema } from "@kobe/protocol";
import { must } from "./testing/event-stream-fixture.js";
import { threadRunsSchema } from "./openapi/runs.js";
import { RunFixture, piDelta } from "./testing/run-fixture.js";

/**
 * Run orchestrator (KOBE-30) against a real Postgres, the real sandbox wire (KOBE-24) over real
 * WebSockets and two server replicas: messages start or queue, the queue advances, steer, stop,
 * edit and delete queued messages, interrupted runs and Retry, authorization, failed starts.
 */
const f = new RunFixture();

beforeAll(async () => {
  await f.setup();
});

afterAll(async () => {
  await f.teardown();
});

describe("messages start a run or queue behind the active one (D17)", () => {
  it("starts a run on the owner's sandbox held by the other replica, then completes it", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 0);
    const threadId = await f.thread(w.owner);
    const res = await f.send(w.owner, threadId, "hello there", 1);
    expect(res.status).toBe(201);
    expect(submitMessageResultSchema.parse(res.json).queued).toBe(false);
    const runId = res.json.run_id as string;
    const start = await ws.started(runId);
    expect(start).toMatchObject({
      thread_id: threadId,
      message: "hello there",
      config: { agent: null, approval_mode: "ask-on-write" },
    });
    expect(start.parent_entry_id).toBeUndefined(); // empty thread: Pi continues from its leaf
    expect(await f.status(w.team, runId)).toBe("running");
    expect(await f.threadStatus(w.team, threadId)).toBe("running");
    const ids = ws.reply(start, "hi!");
    await f.until(w.team, runId, "completed");
    expect(await f.threadStatus(w.team, threadId)).toBe("idle");
    expect(await f.types(w.team, runId)).toEqual([
      "run.started",
      "text.delta",
      "entry.committed",
      "entry.committed",
      "run.completed",
    ]);
    // The prompt's Pi entry is bound to the run once mirrored.
    await expect.poll(async () => (await f.run(w.team, runId)).user_entry_id).toBe(ids.user);
    const snap = await f.on(1, w.owner).get(`/v1/runs/${runId}`);
    expect(snap.status).toBe(200);
    expect(runSnapshotSchema.parse(snap.json)).toMatchObject({
      run_id: runId,
      status: "completed",
      user_entry_id: ids.user,
      approval_mode: "ask-on-write",
    });
  });

  it("queues behind the active run in order and promotes the next when it ends", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const first = await f.message(w.owner, threadId, "one");
    const second = await f.send(w.owner, threadId, "two", 1);
    const third = await f.send(w.owner, threadId, "three", 0);
    expect(second.json.queued).toBe(true);
    expect(third.json.queued).toBe(true);
    const list = await f.on(1, w.owner).get(`/v1/threads/${threadId}/runs`);
    expect(list.status).toBe(200);
    threadRunsSchema.parse(list.json); // the documented response shape
    expect(
      (list.json.runs as { run_id: string; status: string; queue_pos?: number }[]).map((r) => [
        r.run_id,
        r.status,
        r.queue_pos,
      ]),
    ).toEqual([
      [first, "running", undefined],
      [second.json.run_id, "queued", 1],
      [third.json.run_id, "queued", 2],
    ]);
    expect(await f.events(w.team, second.json.run_id as string)).toMatchObject([
      { type: "run.queued", payload: { thread_id: threadId, trigger: "user", queue_pos: 1 } },
    ]);
    const leafBefore = ws.reply(await ws.started(first), "first answer").assistant;
    const startTwo = await ws.started(second.json.run_id as string);
    // The queued run continues from the leaf the previous run left.
    expect(startTwo.parent_entry_id).toBe(leafBefore);
    expect(startTwo.message).toBe("two");
    expect(await f.status(w.team, third.json.run_id as string)).toBe("queued");
    const after = await f.on(0, w.owner).get(`/v1/runs/${third.json.run_id as string}`);
    expect(after.json.queue_pos).toBe(1);
    expect(await f.types(w.team, second.json.run_id as string)).toEqual([
      "run.queued",
      "run.started",
    ]);
    ws.reply(startTwo, "second answer");
    ws.reply(await ws.started(third.json.run_id as string), "third answer");
    await f.until(w.team, third.json.run_id as string, "completed");
    expect(await f.threadStatus(w.team, threadId)).toBe("idle");
  });

  it("edits and deletes queued messages; refuses editing a running one", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const first = await f.message(w.owner, threadId, "one");
    const a = await f.message(w.owner, threadId, "a");
    const b = await f.message(w.owner, threadId, "b");
    const b1 = f.on(1, w.owner);
    expect((await b1.patch(`/v1/runs/${a}`, { content: "a, edited" })).status).toBe(200);
    expect((await b1.patch(`/v1/runs/${first}`, { content: "x" })).json.code).toBe(
      "invalid_transition",
    );
    const del = await b1.post(`/v1/runs/${a}/cancel`);
    expect(del.status).toBe(200);
    expect(del.json).toMatchObject({ status: "cancelled" });
    expect(await f.types(w.team, a)).toEqual(["run.queued", "run.interrupted"]);
    expect((await f.events(w.team, a))[1]?.payload).toEqual({
      reason: "cancelled",
      last_entry_id: null,
      retryable: false,
    });
    expect((await b1.get(`/v1/runs/${b}`)).json.queue_pos).toBe(1);
    // Deleting a queued message neither touches the active run nor the thread.
    expect(await f.status(w.team, first)).toBe("running");
    expect(await f.threadStatus(w.team, threadId)).toBe("running");
    ws.reply(await ws.started(first), "done");
    expect((await ws.started(b)).message).toBe("b");
    expect(await f.auditActions(w.team)).toContain("run.cancelled");
  });

  it("branches from parent_entry_id (edit-and-regenerate) and rejects unknown entries", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const first = await f.message(w.owner, threadId, "one");
    const ids = ws.reply(await ws.started(first), "answer");
    await f.until(w.team, first, "completed");
    const unknown = await f.send(w.owner, threadId, "x", 0, { parent_entry_id: "nope" });
    expect(unknown.status).toBe(404);
    expect(unknown.json.code).toBe("entry_not_found");
    const edit = await f.send(w.owner, threadId, "one, rephrased", 0, {
      parent_entry_id: ids.user,
    });
    expect(edit.status).toBe(201);
    expect((await ws.started(edit.json.run_id as string)).parent_entry_id).toBe(ids.user);
  });

  it("validates bodies strictly", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    const b = f.on(0, w.owner);
    for (const body of [
      {},
      { content: "" },
      { content: "x", extra: 1 },
      { content: "a\u0000b" },
      { content: "x".repeat(200_001) },
    ]) {
      expect((await b.post(`/v1/threads/${threadId}/messages`, body)).status).toBe(400);
    }
    expect((await b.post(`/v1/threads/not-a-uuid/messages`, { content: "x" })).status).toBe(400);
    const files = await b.post(`/v1/threads/${threadId}/messages`, {
      content: "x",
      file_ids: [randomUUID()],
    });
    expect(files.status).toBe(422);
    expect(files.json.code).toBe("attachments_unavailable");
    const run = await f.message(w.owner, threadId, "ok");
    expect((await b.post(`/v1/runs/${run}/steer`, { content: "" })).status).toBe(400);
    expect((await b.patch(`/v1/runs/${run}`, { content: "x", more: 1 })).status).toBe(400);
  });
});

describe("steer (D17)", () => {
  it("injects into the active run and records steer.applied; refuses queued and ended runs", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 1);
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "go");
    const queued = await f.message(w.owner, threadId, "later");
    const start = await ws.started(run);
    ws.event(start, { type: "agent_start" });
    await ws.acked(run);
    const res = await f.on(0, w.owner).post(`/v1/runs/${run}/steer`, { content: "focus on X" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.status).toBe("running");
    expect(ws.sb.frames("run.steer")).toMatchObject([{ run_id: run, message: "focus on X" }]);
    expect((await f.events(w.team, run)).filter((e) => e.type === "steer.applied")).toMatchObject([
      { payload: { content: "focus on X" } },
    ]);
    const q = await f.on(0, w.owner).post(`/v1/runs/${queued}/steer`, { content: "x" });
    expect(q.status).toBe(409);
    expect(q.json.code).toBe("invalid_transition");
    ws.reply(start, "ok");
    await f.until(w.team, run, "completed");
    expect((await f.on(0, w.owner).post(`/v1/runs/${run}/steer`, { content: "x" })).status).toBe(
      409,
    );
  });
});

describe("stop (D17)", () => {
  it("cancels the active run at once, aborts Pi, refuses its late frames and starts the next", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 0);
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "long task");
    const next = await f.message(w.owner, threadId, "next");
    const start = await ws.started(run);
    ws.event(start, { type: "agent_start" });
    ws.event(start, { type: "message_start", message: { role: "assistant" } });
    await ws.acked(run);
    const res = await f.on(1, w.owner).post(`/v1/runs/${run}/cancel`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "cancelled" });
    expect(await f.types(w.team, run)).toEqual(["run.started", "run.interrupted"]);
    expect((await f.events(w.team, run)).at(-1)?.payload).toMatchObject({
      reason: "cancelled",
      retryable: false,
    });
    // Pi is told to abort even though the run already ended in Postgres.
    await ws.sb.until(() =>
      ws.sb.frames("run.stop").find((s) => s.run_id === run && s.mode === "abort"),
    );
    // Late frames of the cancelled run are refused and not stored.
    ws.event(start, piDelta("late"));
    await ws.acked(run);
    expect(await f.types(w.team, run)).toEqual(["run.started", "run.interrupted"]);
    // Stop leaves queued messages in place; the next one starts.
    expect((await ws.started(next)).message).toBe("next");
    // Stop is idempotent; an ended run can't be stopped.
    expect((await f.on(0, w.owner).post(`/v1/runs/${run}/cancel`)).status).toBe(200);
    ws.reply(await ws.started(next), "ok");
    await f.until(w.team, next, "completed");
    expect((await f.on(0, w.owner).post(`/v1/runs/${next}/cancel`)).json.code).toBe(
      "invalid_transition",
    );
    expect(await f.auditActions(w.team)).toContain("run.cancelled");
  });
});

describe("interrupted runs and Retry (D14, Gate 1)", () => {
  it("killing the sandbox mid-run interrupts it, blocks the queue, and Retry runs first with history intact", async () => {
    const w = await f.world();
    let ws = await f.connect(w, 0);
    const threadId = await f.thread(w.owner);
    const first = await f.message(w.owner, threadId, "warm up");
    const base = ws.reply(await ws.started(first), "ready").assistant;
    await f.until(w.team, first, "completed");
    const run = await f.message(w.owner, threadId, "do the risky thing");
    const queued = await f.message(w.owner, threadId, "and then this");
    const start = await ws.started(run);
    expect(start.parent_entry_id).toBe(base);
    // Partial progress is mirrored (turn_end), then the sandbox dies before settling.
    ws.reply(start, "half way", false);
    await ws.acked(run);
    ws.kill();
    await ws.sb.waitClosed();
    await expect
      .poll(async () => {
        await f.fx.replica(1).deps.sandboxWire.sweep();
        return f.status(w.team, run);
      })
      .toBe("interrupted");
    expect(await f.threadStatus(w.team, threadId)).toBe("interrupted");
    expect((await f.events(w.team, run)).at(-1)).toMatchObject({
      type: "run.interrupted",
      payload: { reason: "sandbox_lost", retryable: true },
    });
    // The queue is held: nothing starts after an interrupted run.
    await f.fx.replica(0).deps.runs.idle();
    expect(await f.status(w.team, queued)).toBe("queued");
    const entriesBefore = await f.fx.admin.query(
      `SELECT entry_id FROM thread_entries WHERE team_id = $1 AND thread_id = $2 ORDER BY seq`,
      [w.team, threadId],
    );
    expect(entriesBefore.rowCount).toBe(4); // warm up + answer, risky prompt + partial answer

    ws = await f.connect(w, 1);
    const retry = await f.on(0, w.owner).post(`/v1/runs/${run}/retry`);
    expect(retry.status).toBe(201);
    expect(retry.json.queued).toBe(false);
    const retryId = retry.json.run_id as string;
    expect(await f.run(w.team, retryId)).toMatchObject({
      retry_of_run_id: run,
      input: "do the risky thing",
      status: "running",
    });
    expect(await f.events(w.team, retryId)).toMatchObject([
      { type: "run.started", payload: { thread_id: threadId, retry_of_run_id: run } },
    ]);
    // Same prompt on the same branch point: a sibling branch; the interrupted one stays.
    const retryStart = await ws.started(retryId);
    expect(retryStart).toMatchObject({ message: "do the risky thing", parent_entry_id: base });
    // Repeating Retry returns the same run.
    expect((await f.on(1, w.owner).post(`/v1/runs/${run}/retry`)).json.run_id).toBe(retryId);
    expect(await f.status(w.team, queued)).toBe("queued");
    // The new sandbox had no volume: its Pi session was rebuilt from Postgres before the start.
    expect(ws.sessions.get(threadId)?.map((e) => e.id)).toEqual(
      (entriesBefore.rows as { entry_id: string }[]).map((r) => r.entry_id),
    );
    const retried = ws.reply(retryStart, "done this time");
    await f.until(w.team, retryId, "completed");
    // Both branches exist: the interrupted prompt and the retry are siblings under `base`.
    const parents = await f.fx.admin.query<{ entry_id: string; parent_id: string | null }>(
      `SELECT entry_id, parent_id FROM thread_entries
        WHERE team_id = $1 AND thread_id = $2 AND parent_id = $3`,
      [w.team, threadId, base],
    );
    expect(parents.rows.map((r) => r.entry_id)).toContain(retried.user);
    expect(parents.rowCount).toBe(2);
    // The queue resumes after the retry.
    expect((await ws.started(queued)).message).toBe("and then this");
    const entriesAfter = await f.fx.admin.query<{ entry_id: string }>(
      `SELECT entry_id FROM thread_entries WHERE team_id = $1 AND thread_id = $2`,
      [w.team, threadId],
    );
    for (const row of entriesBefore.rows as { entry_id: string }[]) {
      expect(entriesAfter.rows.map((r) => r.entry_id)).toContain(row.entry_id);
    }
    expect(await f.auditActions(w.team)).toEqual(
      expect.arrayContaining(["run.interrupted", "run.retried"]),
    );
  });

  it("refuses Retry of a run that is not interrupted or not the latest", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const done = await f.message(w.owner, threadId, "one");
    ws.reply(await ws.started(done), "ok");
    await f.until(w.team, done, "completed");
    const notInterrupted = await f.on(0, w.owner).post(`/v1/runs/${done}/retry`);
    expect(notInterrupted.status).toBe(409);
    expect(notInterrupted.json.message).toMatch(/interrupted/);
    // An interrupted run that is no longer the latest ended run can't be retried.
    const lost = await f.message(w.owner, threadId, "two");
    await ws.started(lost);
    await f.fx.replica(0).deps.runs.markSandboxLost(w.team, await sandboxOf(w.team, lost));
    expect(await f.status(w.team, lost)).toBe("interrupted");
    const resume = await f.on(0, w.owner).post(`/v1/threads/${threadId}/queue/resume`);
    expect(resume.status).toBe(200);
    expect(await f.threadStatus(w.team, threadId)).toBe("idle");
    const later = await f.message(w.owner, threadId, "three");
    ws.reply(await ws.started(later), "ok");
    await f.until(w.team, later, "completed");
    const notLatest = await f.on(0, w.owner).post(`/v1/runs/${lost}/retry`);
    expect(notLatest.status).toBe(409);
    expect(notLatest.json.message).toMatch(/latest/);
  });

  it("Continue without retry resumes the held queue", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "one");
    const queued = await f.message(w.owner, threadId, "two");
    await ws.started(run);
    await f.fx.replica(1).deps.runs.markSandboxLost(w.team, await sandboxOf(w.team, run));
    expect(await f.threadStatus(w.team, threadId)).toBe("interrupted");
    await f.fx.replica(1).deps.runs.idle();
    expect(await f.status(w.team, queued)).toBe("queued");
    // A new message on an interrupted thread queues too.
    expect((await f.send(w.owner, threadId, "three")).json.queued).toBe(true);
    const res = await f.on(1, w.owner).post(`/v1/threads/${threadId}/queue/resume`);
    expect(res.status).toBe(200);
    expect((await ws.started(queued)).message).toBe("two");
  });
});

async function sandboxOf(team: string, runId: string): Promise<string> {
  await expect
    .poll(async () => {
      const { rows } = await f.fx.admin.query(
        `SELECT 1 FROM sandbox_run_leases WHERE team_id = $1 AND run_id = $2`,
        [team, runId],
      );
      return rows.length;
    })
    .toBe(1);
  const { rows } = await f.fx.admin.query<{ sandbox_id: string }>(
    `SELECT sandbox_id FROM sandbox_run_leases WHERE team_id = $1 AND run_id = $2`,
    [team, runId],
  );
  return must(rows[0], "lease").sandbox_id;
}

describe("authorization and thread state", () => {
  it("hides runs and threads of teammates and other teams; refuses Trash and non-members", async () => {
    const w = await f.world(1);
    const mate = must(w.others[0], "teammate");
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "mine");
    const other = await f.world();
    for (const [who, label] of [
      [mate, "teammate"],
      [other.owner, "other team"],
    ] as const) {
      const b = f.on(0, who);
      const msg = await b.post(`/v1/threads/${threadId}/messages`, { content: "x" });
      expect(msg.status, label).toBe(404);
      expect(msg.json.code, label).toBe("thread_not_found");
      for (const path of [`/v1/runs/${run}`]) expect((await b.get(path)).status, label).toBe(404);
      for (const action of ["cancel", "retry", "steer"]) {
        const res = await b.post(`/v1/runs/${run}/${action}`, { content: "x" });
        expect(res.status, `${label} ${action}`).toBe(404);
        expect(res.json.code).toBe("run_not_found");
      }
      expect((await b.get(`/v1/threads/${threadId}/runs`)).status, label).toBe(404);
    }
    // Changes need the team header (stale-tab guard), like every team change.
    const noHeader = f.on(0, w.owner);
    noHeader.team = undefined;
    expect((await noHeader.post(`/v1/threads/${threadId}/messages`, { content: "x" })).status).toBe(
      400,
    );
    // Removed members are refused at once.
    await f.fx.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      w.team,
      mate.id,
    ]);
    expect(
      (await f.on(0, mate).post(`/v1/threads/${threadId}/messages`, { content: "x" })).status,
    ).toBe(403);
  });

  it("refuses messages on a thread in Trash; Trash refuses a thread with pending runs", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    const b = f.on(0, w.owner);
    const run = await f.message(w.owner, threadId, "x"); // no sandbox: running, start pending
    expect((await b.delete(`/v1/threads/${threadId}`)).json.code).toBe("thread_busy");
    expect((await b.post(`/v1/runs/${run}/cancel`)).status).toBe(200);
    expect((await b.delete(`/v1/threads/${threadId}`)).status).toBe(200);
    const res = await b.post(`/v1/threads/${threadId}/messages`, { content: "x" });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("thread_in_trash");
  });

  it("fails queued runs of a deactivated owner instead of starting them (KOBE-13)", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "one");
    const queued = await f.message(w.owner, threadId, "two");
    const start = await ws.started(run);
    await f.fx.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [w.owner.id]);
    ws.reply(start, "ok");
    await f.until(w.team, queued, "failed");
    expect((await f.events(w.team, queued)).at(-1)?.payload).toMatchObject({
      error: { code: "account_inactive" },
    });
    await f.fx.admin.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [w.owner.id]);
  });

  it("refuses new runs while the isolation runtime is missing (D4)", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    const runs = f.fx.replica(0).deps.runs;
    runs.useIsolation(() => "missing");
    try {
      const res = await f.send(w.owner, threadId, "x");
      expect(res.status).toBe(503);
      expect(res.json.code).toBe("isolation_unavailable");
    } finally {
      runs.useIsolation(() => "available");
    }
  });

  it("fixes the approval mode at creation, never looser than the install and team floors", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    await f.fx.admin.query(
      `INSERT INTO install_settings (key, value) VALUES ('policy.approval_mode_floor', 'ask-all')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    try {
      const run = await f.message(w.owner, threadId, "x");
      expect((await f.run(w.team, run)).approval_mode).toBe("ask-all");
      expect((await ws.started(run)).config?.approval_mode).toBe("ask-all");
    } finally {
      await f.fx.admin.query(
        `DELETE FROM install_settings WHERE key = 'policy.approval_mode_floor'`,
      );
    }
  });
});

describe("failed starts and recovery", () => {
  it("fails a run whose sandbox never answers run.start, and moves the queue on", async () => {
    const w = await f.world(); // no sandbox connects
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "one");
    const queued = await f.message(w.owner, threadId, "two");
    await f.until(w.team, run, "failed", 15_000);
    expect((await f.events(w.team, run)).at(-1)).toMatchObject({
      type: "run.failed",
      payload: { error: { code: "timeout" } },
    });
    await f.until(w.team, queued, "running");
    // The waking sandbox gets the queued run's start when it connects.
    const ws = await f.connect(w, 1);
    expect((await ws.started(queued)).message).toBe("two");
  });

  it("delivers to a sandbox that connects after the message (wake)", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "hello");
    const ws = await f.connect(w, 1);
    ws.reply(await ws.started(run), "hi");
    await f.until(w.team, run, "completed");
  });

  it("the sweep fails runs whose start was lost and promotes stalled queues", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    const ids = await f.fx.admin.query<{ id: string }>(
      `INSERT INTO runs (team_id, thread_id, trigger, status, started_at, input)
       VALUES ($1, $2, 'user', 'running', now() - interval '1 hour', 'lost')
       RETURNING id`,
      [w.team, threadId],
    );
    const lost = must(ids.rows[0], "run").id;
    await f.fx.admin.query(`UPDATE threads SET status = 'running' WHERE id = $1`, [threadId]);
    const stalled = await f.fx.admin.query<{ id: string }>(
      `INSERT INTO runs (team_id, thread_id, trigger, status, queue_pos, input, created_at)
       VALUES ($1, $2, 'user', 'queued', 1, 'stalled', now() - interval '1 hour') RETURNING id`,
      [w.team, threadId],
    );
    const result = await f.fx.replica(1).deps.runs.sweep();
    expect(result.failedStarts.map((x) => x.transition.runId)).toContain(lost);
    expect((await f.events(w.team, lost)).at(-1)).toMatchObject({
      type: "run.failed",
      payload: { error: { code: "start_lost" } },
    });
    await f.until(w.team, must(stalled.rows[0], "run").id, "running");
  });
});

describe("budget stop (D30 seam for KOBE-42)", () => {
  it("stops queued runs at once and the active run after its step", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "one");
    const queued = await f.message(w.owner, threadId, "two");
    const start = await ws.started(run);
    const affected = await f.fx.replica(1).deps.runs.stopForBudget({
      team_id: w.team,
      user_id: w.owner.id,
      scope: "user",
    });
    expect([...affected].sort()).toEqual([run, queued].sort());
    expect(await f.status(w.team, queued)).toBe("budget_stopped");
    const stop = await ws.sb.until(() => ws.sb.frames("run.stop").find((s) => s.run_id === run));
    expect(stop).toMatchObject({ mode: "after_step", reason: "budget_exhausted" });
    // Pi finishes the step and settles: the run ends budget_stopped, not completed.
    ws.reply(start, "step done");
    await f.until(w.team, run, "budget_stopped");
    expect((await f.events(w.team, run)).at(-1)).toMatchObject({
      type: "run.budget_stopped",
      payload: { scope: "user" },
    });
    expect(await f.threadStatus(w.team, threadId)).toBe("idle");
    expect(await f.auditActions(w.team)).toContain("run.budget_stopped");
  });
});

describe("transition listeners (KOBE-10/64 seam)", () => {
  it("reports transitions decided here and runs the wire ended", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const seen: string[] = [];
    const off = f.fx
      .replica(0)
      .deps.runs.onTransition((t) => seen.push(`${t.from}>${t.to}:${t.cause}`));
    try {
      const run = await f.message(w.owner, threadId, "one");
      ws.reply(await ws.started(run), "ok");
      await expect
        .poll(() => seen)
        .toEqual(["queued>running:dequeued", "running>completed:settled"]);
    } finally {
      off();
    }
  });
});

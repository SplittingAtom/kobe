import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { lockOwnedThread } from "./runs/access.js";
import { DbRunOrchestrator } from "./runs/orchestrator.js";
import { RunError } from "./runs/errors.js";
import { must } from "./testing/event-stream-fixture.js";
import { RunFixture, piDelta } from "./testing/run-fixture.js";

/**
 * Run orchestrator (KOBE-30), coordinator review round: Retry edge cases, the interrupted run after
 * a reload, durable stops (crash between commit and send), lost starts re-sent, idempotent
 * messages, and races with forced interleavings (a second connection holds the thread row).
 */
const f = new RunFixture();

beforeAll(async () => {
  await f.setup();
});

afterAll(async () => {
  await f.teardown();
});

const actorOf = (team: string, userId: string) => ({
  user_id: userId,
  team_id: team,
  install_role: "user" as const,
  team_role: "member" as const,
});

/** A second connection holding the thread row (as another writer would), released by `release`. */
async function holdThread(team: string, threadId: string) {
  const client = new pg.Client({ connectionString: f.fx.database.adminUrl });
  await client.connect();
  await client.query("BEGIN");
  await client.query("SELECT 1 FROM threads WHERE team_id = $1 AND id = $2 FOR UPDATE", [
    team,
    threadId,
  ]);
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
  return {
    /**
     * Sessions waiting for a lock in this database (the holder's waiters; a later waiter on the same
     * row queues behind the first one, so it is not "blocked by" the holder itself).
     */
    async waiters(): Promise<number> {
      const { rows } = await f.fx.admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`,
        [pid],
      );
      return Number(must(rows[0], "count").n);
    },
    async release(): Promise<void> {
      await client.query("ROLLBACK");
      await client.end();
    },
  };
}

async function interrupt(team: string, runId: string): Promise<void> {
  const { rows } = await f.fx.admin.query<{ sandbox_id: string }>(
    `SELECT sandbox_id FROM sandbox_run_leases WHERE team_id = $1 AND run_id = $2`,
    [team, runId],
  );
  await f.fx.replica(0).deps.runs.markSandboxLost(team, must(rows[0], "lease").sandbox_id);
  expect(await f.status(team, runId)).toBe("interrupted");
}

async function leased(team: string, runId: string): Promise<void> {
  await expect
    .poll(async () => {
      const { rows } = await f.fx.admin.query(
        `SELECT 1 FROM sandbox_run_leases WHERE team_id = $1 AND run_id = $2`,
        [team, runId],
      );
      return rows.length;
    })
    .toBe(1);
}

describe("Retry (review items 1, 4, L1)", () => {
  it("still works after a queued message behind the interrupted run was deleted", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const a = await f.message(w.owner, threadId, "A");
    const b = await f.message(w.owner, threadId, "B");
    await ws.started(a);
    await leased(w.team, a);
    await interrupt(w.team, a);
    // B never ran; deleting it must not hide A from Retry.
    expect((await f.on(0, w.owner).post(`/v1/runs/${b}/cancel`)).status).toBe(200);
    const retry = await f.on(1, w.owner).post(`/v1/runs/${a}/retry`);
    expect(retry.status, JSON.stringify(retry.json)).toBe(201);
    expect((await ws.started(retry.json.run_id as string)).message).toBe("A");
  });

  it("is refused after Continue without retry, and re-clamps the mode to today's floor", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const a = await f.message(w.owner, threadId, "A");
    await ws.started(a);
    await leased(w.team, a);
    await interrupt(w.team, a);
    await f.fx.admin.query(
      `INSERT INTO install_settings (key, value) VALUES ('policy.approval_floor', 'ask-all')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    try {
      const retry = await f.on(0, w.owner).post(`/v1/runs/${a}/retry`);
      expect(retry.status).toBe(201);
      expect((await f.run(w.team, retry.json.run_id as string)).approval_mode).toBe("ask-all");
    } finally {
      await f.fx.admin.query(`DELETE FROM install_settings WHERE key = 'policy.approval_floor'`);
    }

    const w2 = await f.world();
    const ws2 = await f.connect(w2);
    const t2 = await f.thread(w2.owner);
    const c = await f.message(w2.owner, t2, "C");
    await ws2.started(c);
    await leased(w2.team, c);
    await interrupt(w2.team, c);
    await f.on(0, w2.owner).post(`/v1/threads/${t2}/queue/resume`);
    const refused = await f.on(0, w2.owner).post(`/v1/runs/${c}/retry`);
    expect(refused.status).toBe(409);
    expect(refused.json.message).toMatch(/only offered while the thread is interrupted/);
  });

  it("says so when the one Retry was used and the retry did not succeed", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const a = await f.message(w.owner, threadId, "A");
    await ws.started(a);
    await leased(w.team, a);
    await interrupt(w.team, a);
    const retry = (await f.on(0, w.owner).post(`/v1/runs/${a}/retry`)).json.run_id as string;
    expect((await f.on(0, w.owner).post(`/v1/runs/${a}/retry`)).json.run_id).toBe(retry);
    await f.on(0, w.owner).post(`/v1/runs/${retry}/cancel`);
    const again = await f.on(0, w.owner).post(`/v1/runs/${a}/retry`);
    expect(again.status).toBe(409);
    expect(again.json.message).toMatch(/already retried once, and the retry cancelled/);
  });
});

describe("the interrupted run survives a reload (review item 2)", () => {
  it("GET /v1/threads/{id}/runs names it while the thread is interrupted", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const a = await f.message(w.owner, threadId, "A");
    const queued = await f.message(w.owner, threadId, "B");
    await ws.started(a);
    await leased(w.team, a);
    const before = await f.on(1, w.owner).get(`/v1/threads/${threadId}/runs`);
    expect(before.json.interrupted_run).toBeNull();
    await interrupt(w.team, a);
    const after = await f.on(1, w.owner).get(`/v1/threads/${threadId}/runs`);
    expect(after.json.interrupted_run).toMatchObject({ run_id: a, status: "interrupted" });
    expect(after.json.runs.map((r: { run_id: string }) => r.run_id)).toEqual([queued]);
    const retry = (await f.on(0, w.owner).post(`/v1/runs/${a}/retry`)).json.run_id as string;
    expect(
      (await f.on(1, w.owner).get(`/v1/threads/${threadId}/runs`)).json.interrupted_run,
    ).toBeNull();
    ws.reply(await ws.started(retry), "ok");
    await f.until(w.team, retry, "completed");
  });
});

describe("durable stops (review item 3)", () => {
  it("the sweep sends the abort a replica committed but never sent", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "A");
    const start = await ws.started(run);
    await leased(w.team, run);
    // What a Stop commits, without the send that follows (the replica died in between).
    await f.fx.admin.query(
      `UPDATE runs SET status = 'cancelled', ended_at = now(), stop_mode = 'abort',
              stop_requested_at = now() - interval '5 minutes'
        WHERE team_id = $1 AND id = $2`,
      [w.team, run],
    );
    await f.fx.admin.query(`UPDATE threads SET status = 'idle' WHERE id = $1`, [threadId]);
    expect(ws.sb.frames("run.stop")).toHaveLength(0);
    const result = await f.fx.replica(1).deps.runs.sweep();
    expect(result.pendingStops.map((s) => s.runId)).toContain(run);
    await ws.sb.until(() =>
      ws.sb.frames("run.stop").find((s) => s.run_id === run && s.mode === "abort"),
    );
    await expect
      .poll(async () => {
        const { rows } = await f.fx.admin.query<{ stop_mode: string | null }>(
          `SELECT stop_mode FROM runs WHERE id = $1`,
          [run],
        );
        return rows[0]?.stop_mode;
      })
      .toBeNull();
    // Late frames of the stopped run are still refused.
    ws.event(start, piDelta("late"));
    await ws.acked(run);
    expect(await f.types(w.team, run)).toEqual(["run.started"]);
  });

  it("finishes a budget stop whose sender died, and never wakes a disconnected sandbox", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "A");
    await ws.started(run);
    await leased(w.team, run);
    await f.fx.admin.query(
      `UPDATE runs SET budget_stop_scope = 'team', stop_mode = 'after_step',
              stop_requested_at = now() - interval '5 minutes' WHERE id = $1`,
      [run],
    );
    await f.fx.replica(0).deps.runs.sweep();
    await ws.sb.until(() =>
      ws.sb.frames("run.stop").find((s) => s.run_id === run && s.mode === "after_step"),
    );
    await f.until(w.team, run, "budget_stopped");

    // A Stop committed while the sandbox is gone: cleared without a wake (its hello aborts).
    const w2 = await f.world();
    const threadId2 = await f.thread(w2.owner);
    const run2 = await f.message(w2.owner, threadId2, "B");
    await f.fx.admin.query(
      `UPDATE runs SET status = 'cancelled', ended_at = now(), stop_mode = 'abort',
              stop_requested_at = now() - interval '5 minutes' WHERE id = $1`,
      [run2],
    );
    await f.fx.replica(0).deps.runs.sweep();
    await f.fx.replica(0).deps.runs.idle();
    const { rows } = await f.fx.admin.query<{ stop_mode: string | null }>(
      `SELECT stop_mode FROM runs WHERE id = $1`,
      [run2],
    );
    expect(rows[0]?.stop_mode).toBeNull();
  });
});

describe("lost starts and idempotent messages (L3, L6, L2)", () => {
  it("re-sends a recent run.start that was never delivered", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const { rows } = await f.fx.admin.query<{ id: string }>(
      `INSERT INTO runs (team_id, thread_id, trigger, status, started_at, input)
       VALUES ($1, $2, 'user', 'running', now() - interval '1 minute', 'recover me') RETURNING id`,
      [w.team, threadId],
    );
    const run = must(rows[0], "run").id;
    await f.fx.replica(1).deps.runs.sweep();
    expect((await ws.started(run)).message).toBe("recover me");
    expect(await f.status(w.team, run)).toBe("running");
  });

  it("answers a repeated message with the run the first one created", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    const other = await f.thread(w.owner);
    const send = (thread: string, key: string, replica: number) =>
      f
        .on(replica, w.owner)
        .request(
          "POST",
          `/v1/threads/${thread}/messages`,
          { content: "x" },
          { "idempotency-key": key },
        );
    const [a, b] = await Promise.all([send(threadId, "k-1", 0), send(threadId, "k-1", 1)]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.json.run_id).toBe(a.json.run_id);
    expect((await send(other, "k-1", 0)).json.run_id).not.toBe(a.json.run_id);
    expect((await send(threadId, "bad key", 0)).status).toBe(400);
  });

  it("does not report queued for a run that failed in the same transaction", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    const deps = f.fx.replica(0).deps;
    const failing = new DbRunOrchestrator({
      db: deps.database.db,
      router: deps.sandboxWire.router,
      sweep: false,
      agents: { resolve: () => Promise.reject(new Error("resolver down")) },
    });
    try {
      const res = await failing.submitMessage(actorOf(w.team, w.owner.id), {
        thread_id: threadId,
        trigger: "user",
        content: "x",
      });
      expect(res.queued).toBe(false);
      expect(await f.status(w.team, res.run_id)).toBe("failed");
      expect((await f.events(w.team, res.run_id)).at(-1)?.payload).toMatchObject({
        error: { code: "agent_unavailable" },
      });
    } finally {
      failing.close();
    }
  });
});

describe("forced interleavings and edges (L7)", () => {
  it("answers 409 thread_busy when the thread row is held past the lock timeout", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    const held = await holdThread(w.team, threadId);
    try {
      const res = await f.send(w.owner, threadId, "x");
      expect(res.status).toBe(409);
      expect(res.json.code).toBe("thread_busy");
    } finally {
      await held.release();
    }
    expect((await f.send(w.owner, threadId, "x")).status).toBe(201);
  });

  it("Stop and Pi's settle queued behind the same thread lock: the run ends exactly once", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "A");
    const start = await ws.started(run);
    ws.event(start, { type: "agent_start" });
    await ws.acked(run);
    const held = await holdThread(w.team, threadId);
    let stop: ReturnType<ReturnType<typeof f.on>["post"]> | undefined;
    try {
      // Pi settles: the wire's mirroring transaction waits on the thread row first…
      ws.reply(start, "done");
      await expect.poll(() => held.waiters(), { timeout: 5_000 }).toBe(1);
      // …then Stop queues behind it (both blocked before either writes).
      stop = f.on(1, w.owner).post(`/v1/runs/${run}/cancel`);
      await expect.poll(() => held.waiters(), { timeout: 1_500 }).toBe(2);
    } finally {
      await held.release();
    }
    const res = await must(stop, "stop");
    expect([200, 409]).toContain(res.status);
    await expect.poll(() => f.status(w.team, run)).toMatch(/^(cancelled|completed)$/);
    const terminal = (await f.types(w.team, run)).filter((t) =>
      ["run.completed", "run.interrupted", "run.failed"].includes(t),
    );
    expect(terminal).toHaveLength(1);
  });

  it("promotion waits out a busy thread row (backoff); two run-ended hooks start one run", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const queuedOn = async (threadId: string) => {
      for (let i = 1; i <= 2; i += 1) {
        await f.fx.admin.query(
          `INSERT INTO runs (team_id, thread_id, trigger, status, queue_pos, input)
           VALUES ($1, $2, 'user', 'queued', $3, 'q')`,
          [w.team, threadId, i],
        );
      }
    };
    const running = async (threadId: string) =>
      (
        await f.fx.admin.query(`SELECT 1 FROM runs WHERE thread_id = $1 AND status = 'running'`, [
          threadId,
        ])
      ).rows.length;

    const busy = await f.thread(w.owner);
    await queuedOn(busy);
    const held = await holdThread(w.team, busy);
    let hook: Promise<void> | undefined;
    try {
      hook = f.fx.replica(0).deps.runs.onRunEnded({ teamId: w.team, runId: busy, threadId: busy });
      // Waiting, then its lock timeout (no waiter during the backoff), then waiting again.
      await expect.poll(() => held.waiters(), { timeout: 3_000, interval: 20 }).toBe(1);
      await expect.poll(() => held.waiters(), { timeout: 5_000, interval: 20 }).toBe(0);
      await expect.poll(() => held.waiters(), { timeout: 5_000, interval: 20 }).toBe(1);
    } finally {
      await held.release();
    }
    await hook;
    expect(await running(busy)).toBe(1);

    const twice = await f.thread(w.owner);
    await queuedOn(twice);
    const ended = { teamId: w.team, runId: twice, threadId: twice };
    await Promise.all([
      f.fx.replica(0).deps.runs.onRunEnded(ended),
      f.fx.replica(1).deps.runs.onRunEnded(ended),
    ]);
    expect(await running(twice)).toBe(1);
    await expect.poll(() => ws.starts().filter((s) => s.thread_id === twice).length).toBe(1);
  });

  it("a project reader of a shared thread is read-only", async () => {
    const w = await f.world(1);
    const reader = must(w.others[0], "reader");
    const threadId = await f.thread(w.owner);
    const projectId = "5b9d6c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e";
    await f.fx.admin.query(
      `UPDATE threads SET project_id = $1, shared_to_project = true WHERE id = $2`,
      [projectId, threadId],
    );
    const err = await withTeam(f.fx.db, w.team, (tx) =>
      lockOwnedThread(
        tx,
        { teamId: w.team, userId: reader.id, projectIds: [projectId] },
        threadId,
        "thread_not_found",
      ),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunError);
    expect((err as RunError).code).toBe("read_only");
  });

  it("a deactivated user can't steer", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "A");
    await ws.started(run);
    await f.fx.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [w.owner.id]);
    try {
      const err = await f.fx
        .replica(0)
        .deps.runs.steer(actorOf(w.team, w.owner.id), run, { content: "x" })
        .catch((e: unknown) => e);
      expect((err as RunError).code).toBe("forbidden");
      expect(ws.sb.frames("run.steer")).toHaveLength(0);
    } finally {
      await f.fx.admin.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [w.owner.id]);
    }
  });
});

describe("pinned agent at run start (KOBE-46)", () => {
  it("starts with the thread's exact pinned version and fails visibly when it is unavailable", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const b = f.on(0, w.owner);
    const created = await b.post("/v1/agents", {
      scope: "team",
      frontmatter: { name: "Pinned" },
      prompt: "v1",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const agentId = created.json.agent.id as string;
    expect(
      (await b.request("POST", `/v1/agents/${agentId}/publish`, {}, { "if-match": "*" })).status,
    ).toBe(201);
    const thread = await b.post("/v1/threads", { agent_id: agentId });
    expect(thread.status, JSON.stringify(thread.json)).toBe(201);
    const threadId = thread.json.thread_id as string;
    const run = await f.message(w.owner, threadId, "hi");
    const start = await ws.started(run);
    expect(start.config?.agent).toEqual({ agent_id: agentId, version: 1 });
    expect(await f.events(w.team, run)).toMatchObject([
      { type: "run.started", payload: { agent_id: agentId, agent_version: 1 } },
      // No team default model here: KOBE-77 reports that as an omission.
      {
        type: "context.omitted",
        payload: { items: [{ kind: "model", reason: "no_team_default" }] },
      },
    ]);
    ws.reply(start, "ok");
    await f.until(w.team, run, "completed");
    // Never a fallback: a suspended agent fails the thread's next run.
    await f.fx.admin.query(`UPDATE team_agents SET status = 'suspended' WHERE id = $1`, [agentId]);
    const next = await f.message(w.owner, threadId, "again");
    expect(await f.status(w.team, next)).toBe("failed");
    expect((await f.events(w.team, next)).at(-1)?.payload).toMatchObject({
      error: { code: "agent_suspended", message: expect.stringContaining("suspended") },
    });
  });

  it("refuses runs of a personal agent the team suspended (KOBE-86)", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const b = f.on(0, w.owner);
    const created = await b.post("/v1/agents", {
      scope: "personal",
      frontmatter: { name: "Mine" },
      prompt: "v1",
    });
    const agentId = created.json.agent.id as string;
    await b.request("POST", `/v1/agents/${agentId}/publish`, {}, { "if-match": "*" });
    const thread = await b.post("/v1/threads", { agent_id: agentId });
    const threadId = thread.json.thread_id as string;
    const first = await f.message(w.owner, threadId, "hi");
    ws.reply(await ws.started(first), "ok");
    await f.until(w.team, first, "completed");
    await f.fx.admin.query(
      `INSERT INTO team_agent_suspensions (team_id, agent_id, agent_scope, suspended_by)
       VALUES ($1, $2, 'personal', $3)`,
      [w.team, agentId, w.owner.id],
    );
    const next = await f.message(w.owner, threadId, "again");
    expect(await f.status(w.team, next)).toBe("failed");
    expect((await f.events(w.team, next)).at(-1)?.payload).toMatchObject({
      error: { code: "agent_suspended" },
    });
  });
});

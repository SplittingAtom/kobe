import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SANDBOX_CLOSE_CODES, SANDBOX_MAX_FRAME_BYTES } from "@kobe/protocol";
import { sql, withTeam } from "@kobe/db";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";

/**
 * Sandbox connection registry and routing (KOBE-24) against a real Postgres, real WebSockets and
 * two server replicas on one database: routing across replicas, durable cursor (duplicates, gaps,
 * reconnect + resume), leasing, late frames, cross-team isolation, a compromised sandbox, policy
 * checks, interrupted runs.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
const ended: { runId: string; status: string }[] = [];
const woken: string[] = [];
const sandboxes: FakeSandbox[] = [];

beforeAll(async () => {
  await fx.setup([{}, {}], () => ({
    sandboxWire: {
      sweep: false,
      tuning: {
        batchWindowMs: 20,
        resultPollMs: 200,
        lostGraceMs: 0,
        helloTimeoutMs: 1_000,
        frameBurst: 400,
        frameRatePerSec: 100,
        // Every test connects from 127.0.0.1, so they all share one upgrade bucket; the production
        // limit (20, refilling 2/s) throttles the suite on slower CI runners.
        upgradeBurst: 1_000,
        upgradeRatePerSec: 100,
      },
      hooks: { onRunEnded: (e) => void ended.push({ runId: e.runId, status: e.status }) },
      waker: { wake: (t) => Promise.resolve(void woken.push(t.userId)) },
    },
  }));
  listeners.push(await sandboxListener(fx.replica(0).deps, auth));
  listeners.push(await sandboxListener(fx.replica(1).deps, auth));
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  for (const l of listeners) await l.close();
  await fx.teardown();
});

const url = (replica: number) => must(listeners[replica], "listener").url;

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly runId: string;
  readonly threadId: string;
  readonly sandboxId: string;
  readonly token: string;
  readonly target: { teamId: string; userId: string };
}

async function threadOf(teamId: string, runId: string): Promise<string> {
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [teamId, runId],
  );
  return must(rows[0], "run").thread_id;
}

async function world(): Promise<World> {
  const owner = await fx.person(`u${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`w-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  const threadId = await threadOf(team, runId);
  const sandboxId = randomUUID();
  const token = auth.issue({ sandboxId, teamId: team, userId: owner.id });
  return {
    team,
    owner,
    runId,
    threadId,
    sandboxId,
    token,
    target: { teamId: team, userId: owner.id },
  };
}

async function newRun(w: World): Promise<{ runId: string; threadId: string }> {
  const runId = await fx.run(w.team, w.owner);
  return { runId, threadId: await threadOf(w.team, runId) };
}

async function connect(
  replica: number,
  w: World,
  runs: { run_id: string; thread_id: string; last_seq: number }[] = [],
): Promise<FakeSandbox> {
  const sb = await FakeSandbox.connect(url(replica), w.token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(w.sandboxId, runs);
  await sb.ready();
  return sb;
}

/** Connects and starts `w.runId` on the sandbox through the other replica's router. */
async function started(w: World, holder = 0, requester = 1): Promise<FakeSandbox> {
  const sb = await connect(holder, w);
  const result = await fx.replica(requester).deps.sandboxWire.router.startRun(w.target, {
    runId: w.runId,
    threadId: w.threadId,
    message: "hello",
  });
  expect(result).toEqual({ ok: true });
  return sb;
}

async function events(
  teamId: string,
  runId: string,
): Promise<{ seq: number; type: string; payload: Record<string, unknown> }[]> {
  const { rows } = await fx.admin.query<{
    seq: number;
    type: string;
    payload: Record<string, unknown>;
  }>(`SELECT seq, type, payload FROM run_events WHERE team_id = $1 AND run_id = $2 ORDER BY seq`, [
    teamId,
    runId,
  ]);
  return rows;
}

async function runRow(teamId: string, runId: string) {
  const { rows } = await fx.admin.query<{ status: string; sandbox_seq: number }>(
    `SELECT status, sandbox_seq FROM runs WHERE team_id = $1 AND id = $2`,
    [teamId, runId],
  );
  return must(rows[0], "run");
}

const delta = (text: string) => ({
  type: "message_update",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
});
const assistantStart = { type: "message_start", message: { role: "assistant" } };
const assistantEnd = { type: "message_end", message: { role: "assistant" } };

/** Waits for both replicas' off-path work (audit rows of refused tokens and violations). */
const settled = () =>
  Promise.all([0, 1].map((i) => fx.replica(i).deps.background.idle())).then(() => undefined);

async function auditActions(teamId: string): Promise<string[]> {
  const { rows } = await fx.admin.query<{ action: string }>(
    `SELECT action FROM audit_log WHERE team_id = $1 ORDER BY seq`,
    [teamId],
  );
  return rows.map((r) => r.action);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("upgrade authentication", () => {
  it("refuses missing, invalid and dead credentials, and the wrong path or subprotocol", async () => {
    const w = await world();
    const status = async (p: Promise<FakeSandbox | { status: number }>) => {
      const r = await p;
      if (isFake(r)) {
        r.close();
        return 101;
      }
      return r.status;
    };
    expect(await status(FakeSandbox.connect(url(0), undefined))).toBe(401);
    expect(await status(FakeSandbox.connect(url(0), "tok-forged"))).toBe(401);
    expect(await status(FakeSandbox.connect(url(0), w.token, { protocol: "other" }))).toBe(400);
    expect(await status(FakeSandbox.connect(url(0).replace("/connect", "/nope"), w.token))).toBe(
      404,
    );
    expect(
      await status(
        FakeSandbox.connect(url(0), w.token, { headers: { "x-forwarded-for": "1.2.3.4" } }),
      ),
    ).toBe(404);
    auth.dead.add(w.sandboxId);
    expect(await status(FakeSandbox.connect(url(0), w.token))).toBe(401);
    auth.dead.delete(w.sandboxId);
    // Not a member of the team the token names.
    const stranger = await fx.person("stranger");
    const foreign = auth.issue({ sandboxId: randomUUID(), teamId: w.team, userId: stranger.id });
    expect(await status(FakeSandbox.connect(url(0), foreign))).toBe(401);
    expect(await status(FakeSandbox.connect(url(0), w.token))).toBe(101);
    // Signed tokens refused after verification are audited (forged ones carry no team).
    await settled();
    expect((await auditActions(w.team)).filter((x) => x === "sandbox.token_rejected")).toHaveLength(
      2,
    );
  });

  it("closes on a hello for another sandbox, an unsupported Pi, a frame before hello, or no hello", async () => {
    const w = await world();
    const open = async () => {
      const sb = await FakeSandbox.connect(url(0), w.token);
      if (!isFake(sb)) throw new Error("refused");
      sandboxes.push(sb);
      return sb;
    };
    const a = await open();
    a.hello(randomUUID());
    expect((await a.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.unauthorized);
    await settled();
    expect(await auditActions(w.team)).toContain("sandbox.token_rejected");
    const b = await open();
    b.hello(w.sandboxId, [], "2.0.0");
    expect((await b.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.unsupported_version);
    const c = await open();
    c.event(w.runId, w.threadId, 1, { type: "agent_start" });
    expect((await c.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.protocol_error);
    const d = await open();
    expect((await d.waitClosed(5_000)).code).toBe(SANDBOX_CLOSE_CODES.hello_timeout);
  });
});

describe("routing across replicas", () => {
  it("delivers run.start from replica 1 to the sandbox held by replica 0 and returns its result", async () => {
    const w = await world();
    const sb = await started(w, 0, 1);
    const [getEntries] = sb.frames("pi.command");
    expect(getEntries?.command.type).toBe("get_entries"); // session checked before the first run
    expect(sb.frames("run.start")[0]).toMatchObject({
      run_id: w.runId,
      thread_id: w.threadId,
      message: "hello",
    });
    const { rows } = await fx.admin.query(
      `SELECT sandbox_id FROM sandbox_run_leases WHERE team_id = $1 AND run_id = $2`,
      [w.team, w.runId],
    );
    expect(rows).toEqual([{ sandbox_id: w.sandboxId }]);
    // Content-bearing rows are deleted once the requester has its result.
    const left = await fx.admin.query(`SELECT 1 FROM sandbox_commands WHERE team_id = $1`, [
      w.team,
    ]);
    expect(left.rowCount).toBe(0);
    expect(await fx.replica(1).deps.sandboxWire.router.isConnected(w.target)).toBe(true);
  });

  it("routes pi.command and steer, and fails steer for a run not on the sandbox", async () => {
    const w = await world();
    const sb = await started(w);
    const router = fx.replica(1).deps.sandboxWire.router;
    sb.respond = (f) =>
      f.type === "pi.command" && f.command.type === "get_state"
        ? { v: 1, type: "command.result", command_id: f.command_id, ok: true, data: { model: "m" } }
        : undefined;
    expect(
      await router.piCommand(w.target, {
        threadId: w.threadId,
        command: { id: "x", type: "get_state" },
      }),
    ).toEqual({ ok: true, data: { model: "m" } });
    expect(
      await router.steerRun(w.target, { runId: w.runId, threadId: w.threadId, message: "also" }),
    ).toEqual({ ok: true });
    const other = await newRun(w);
    const steer = await router.steerRun(w.target, { ...other, message: "x" });
    expect(steer).toMatchObject({ ok: false, error: { code: "run_not_active" } });
  });

  it("queues commands for a disconnected sandbox, wakes it, and delivers on connect", async () => {
    const w = await world();
    const pending = fx.replica(1).deps.sandboxWire.router.startRun(w.target, {
      runId: w.runId,
      threadId: w.threadId,
      message: "later",
    });
    await expect.poll(() => woken).toContain(w.owner.id);
    const sb = await connect(0, w);
    expect(await pending).toEqual({ ok: true });
    expect(sb.frames("run.start")).toHaveLength(1);
  });

  it("times out when no sandbox answers", async () => {
    const w = await world();
    const result = await fx
      .replica(0)
      .deps.sandboxWire.router.steerRun(
        w.target,
        { runId: w.runId, threadId: w.threadId, message: "x" },
        { timeoutMs: 300 },
      );
    expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("never routes into another user's thread", async () => {
    const w = await world();
    const mallory = await fx.person("mallory");
    await fx.addMember(w.team, mallory);
    const result = await fx
      .replica(0)
      .deps.sandboxWire.router.startRun(
        { teamId: w.team, userId: mallory.id },
        { runId: w.runId, threadId: w.threadId, message: "x" },
      );
    expect(result).toMatchObject({ ok: false, error: { code: "thread_not_found" } });
  });

  it("a run.start the sandbox rejects fails the run", async () => {
    const w = await world();
    const sb = await connect(0, w);
    sb.respond = (f) =>
      f.type === "run.start"
        ? {
            v: 1,
            type: "command.result",
            command_id: f.command_id,
            ok: false,
            error: { code: "pi_rejected", message: "no model" },
          }
        : undefined;
    const r = await fx.replica(1).deps.sandboxWire.router.startRun(w.target, {
      runId: w.runId,
      threadId: w.threadId,
      message: "x",
    });
    expect(r).toMatchObject({ ok: false, error: { code: "pi_rejected" } });
    await expect.poll(async () => (await runRow(w.team, w.runId)).status).toBe("failed");
    expect((await events(w.team, w.runId)).at(-1)?.type).toBe("run.failed");
  });
});

describe("event ingest and the durable cursor", () => {
  it("fails the run with the server's message when the last model call failed (KOBE-41)", async () => {
    const w = await world();
    const sb = await started(w);
    sb.session = [];
    const frames = [
      { type: "agent_start" },
      assistantStart,
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "kobe.model_error:model_not_enabled: model_not_enabled after 1 attempt",
        },
      },
      { type: "turn_end", message: { role: "assistant" } },
      { type: "agent_settled" },
    ];
    frames.forEach((e, i) => sb.event(w.runId, w.threadId, i + 1, e));
    await sb.until(() => sb.acked(w.runId) >= frames.length);
    const evs = await events(w.team, w.runId);
    expect(evs.map((e) => e.type)).toEqual(["run.failed"]);
    expect(evs[0]?.payload).toEqual({
      error: {
        code: "model_not_enabled",
        message:
          "That model is not enabled for your team. Ask a team admin to enable it, or use the team's default model.",
      },
    });
    expect((await runRow(w.team, w.runId)).status).toBe("failed");

    // Any other error text: a generic model error, the sandbox's words never stored.
    const second = await newRun(w);
    const sb2 = await connect(0, w);
    expect(
      await fx.replica(1).deps.sandboxWire.router.startRun(w.target, {
        runId: second.runId,
        threadId: second.threadId,
        message: "again",
      }),
    ).toEqual({ ok: true });
    const bad = [
      { type: "agent_start" },
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "<b>evil</b>" },
      },
      { type: "agent_settled" },
    ];
    bad.forEach((e, i) => sb2.event(second.runId, second.threadId, i + 1, e));
    await sb2.until(() => sb2.acked(second.runId) >= bad.length);
    const failed = (await events(w.team, second.runId)).at(-1);
    expect(failed?.type).toBe("run.failed");
    expect(JSON.stringify(failed?.payload)).not.toContain("evil");
    expect(failed?.payload).toMatchObject({ error: { code: "model_error" } });
  });

  it("translates, batches, mirrors entries and completes the run, acking after commit", async () => {
    const w = await world();
    const sb = await started(w);
    const t = new Date().toISOString();
    sb.session = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: t,
        message: { role: "user", content: "hello" },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: t,
        message: { role: "assistant", content: [{ type: "text", text: "abc" }] },
      },
    ];
    const frames = [
      { type: "agent_start" },
      assistantStart,
      delta("a"),
      delta("b"),
      delta("c"),
      assistantEnd,
      { type: "turn_end", message: { role: "assistant" } },
      { type: "agent_settled" },
    ];
    frames.forEach((e, i) => sb.event(w.runId, w.threadId, i + 1, e));
    await sb.until(() => sb.acked(w.runId) >= frames.length);
    const evs = await events(w.team, w.runId);
    expect(evs.map((e) => e.type)).toEqual([
      "text.delta",
      "entry.committed",
      "entry.committed",
      "run.completed",
    ]);
    expect(evs[0]?.payload).toEqual({ message_id: "m2", content_index: 0, delta: "abc" });
    expect(evs[2]?.payload).toMatchObject({ entry_id: "a1", message_id: "m2" });
    expect(evs[3]?.payload).toEqual({ leaf_entry_id: "a1" });
    expect(await runRow(w.team, w.runId)).toEqual({ status: "completed", sandbox_seq: 8 });
    const { rows } = await fx.admin.query<{ entry_id: string }>(
      `SELECT entry_id FROM thread_entries WHERE team_id = $1 AND thread_id = $2 ORDER BY seq`,
      [w.team, w.threadId],
    );
    expect(rows.map((r) => r.entry_id)).toEqual(["u1", "a1"]);
    await expect
      .poll(() => ended.some((e) => e.runId === w.runId && e.status === "completed"))
      .toBe(true);
  });

  it("drops duplicates (acked) and answers gaps with resend from the durable cursor", async () => {
    const w = await world();
    const sb = await started(w);
    sb.event(w.runId, w.threadId, 1, assistantStart);
    sb.event(w.runId, w.threadId, 2, delta("x"));
    await sb.until(() => sb.acked(w.runId) >= 2);
    sb.event(w.runId, w.threadId, 2, delta("x")); // duplicate
    sb.event(w.runId, w.threadId, 5, delta("z")); // gap: 3, 4 missing
    const resend = await sb.until(() => sb.frames("resend").find((r) => r.run_id === w.runId));
    expect(resend.from_seq).toBe(3);
    sb.event(w.runId, w.threadId, 3, delta("y"));
    sb.event(w.runId, w.threadId, 4, {
      type: "kobe.event_dropped",
      original_type: "x",
      reason: "too_large",
    });
    sb.event(w.runId, w.threadId, 5, delta("z"));
    await sb.until(() => sb.acked(w.runId) >= 5);
    const deltas = (await events(w.team, w.runId)).map(
      (e) => (e.payload as { delta?: string }).delta,
    );
    expect(deltas.join("")).toBe("xyz");
    expect((await runRow(w.team, w.runId)).sandbox_seq).toBe(5);
  });

  it("resumes after a reconnect to the other replica: durable_seq, re-sent duplicates, no loss", async () => {
    const w = await world();
    const first = await started(w, 0, 1);
    first.event(w.runId, w.threadId, 1, assistantStart);
    first.event(w.runId, w.threadId, 2, delta("one "));
    first.event(w.runId, w.threadId, 3, delta("two "));
    await first.until(() => first.acked(w.runId) >= 3);
    first.close();
    // The sandbox comes back on replica 1 having sent up to 5 (4 and 5 never arrived).
    const second = await connect(1, w, [{ run_id: w.runId, thread_id: w.threadId, last_seq: 5 }]);
    const ack = second.frames("hello.ack")[0];
    expect(ack?.runs).toEqual([{ run_id: w.runId, thread_id: w.threadId, durable_seq: 3 }]);
    second.event(w.runId, w.threadId, 3, delta("two ")); // agent re-sends a bit too much
    second.event(w.runId, w.threadId, 4, delta("three "));
    second.event(w.runId, w.threadId, 5, delta("four"));
    await second.until(() => second.acked(w.runId) >= 5);
    const text = (await events(w.team, w.runId))
      .map((e) => (e.payload as { delta?: string }).delta ?? "")
      .join("");
    expect(text).toBe("one two three four");
    // Steer from replica 0 now reaches the sandbox through replica 1.
    expect(
      await fx.replica(0).deps.sandboxWire.router.steerRun(w.target, {
        runId: w.runId,
        threadId: w.threadId,
        message: "more",
      }),
    ).toEqual({ ok: true });
  });

  it("closes the older connection with `replaced` when the sandbox connects again", async () => {
    const w = await world();
    const a = await connect(0, w);
    const b = await connect(1, w);
    expect((await a.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.replaced);
    expect(b.closed).toBeUndefined();
  });
});

describe("interrupted runs (D14)", () => {
  it("interrupts runs the reconnected sandbox no longer lists", async () => {
    const w = await world();
    const first = await started(w);
    first.close();
    await connect(1, w, []); // Pi restarted: the run is gone
    await expect.poll(async () => (await runRow(w.team, w.runId)).status).toBe("interrupted");
    const last = (await events(w.team, w.runId)).at(-1);
    expect(last).toMatchObject({
      type: "run.interrupted",
      payload: { reason: "sandbox_lost", retryable: true },
    });
    const { rows } = await fx.admin.query<{ status: string }>(
      `SELECT status FROM threads WHERE team_id = $1 AND id = $2`,
      [w.team, w.threadId],
    );
    expect(rows[0]?.status).toBe("interrupted");
    expect(await auditActions(w.team)).toContain("run.interrupted");
  });

  it("the sweep interrupts runs whose sandbox stays gone past the grace period", async () => {
    const w = await world();
    const sb = await started(w);
    sb.close();
    await expect
      .poll(async () => {
        const { rows } = await fx.admin.query(
          `SELECT 1 FROM sandbox_connections WHERE team_id = $1 AND closed_at IS NOT NULL`,
          [w.team],
        );
        return rows.length;
      })
      .toBe(1);
    const result = await fx.replica(1).deps.sandboxWire.sweep();
    expect(result.interrupted.map((r) => r.runId)).toContain(w.runId);
    expect((await runRow(w.team, w.runId)).status).toBe("interrupted");
  });

  it("the sweep keeps a run whose sandbox reconnected and resumed it", async () => {
    const w = await world();
    const first = await started(w);
    first.close();
    await connect(1, w, [{ run_id: w.runId, thread_id: w.threadId, last_seq: 0 }]);
    const result = await fx.replica(0).deps.sandboxWire.sweep();
    expect(result.interrupted.map((r) => r.runId)).not.toContain(w.runId);
    expect((await runRow(w.team, w.runId)).status).toBe("running");
  });

  it("pi.exited interrupts the thread's active run", async () => {
    const w = await world();
    const sb = await started(w);
    sb.send({
      v: 1,
      type: "pi.exited",
      thread_id: w.threadId,
      exit_code: 1,
      signal: null,
      stderr_tail: "",
    });
    await expect.poll(async () => (await runRow(w.team, w.runId)).status).toBe("interrupted");
  });
});

describe("late frames for ended runs", () => {
  it("answers run_not_active (acked, not executed) and denies a late policy.check", async () => {
    const w = await world();
    const sb = await started(w);
    sb.event(w.runId, w.threadId, 1, assistantStart);
    await sb.until(() => sb.acked(w.runId) >= 1);
    // Stop, the way the orchestrator ends a run: status and terminal event together.
    await withTeam(fx.db, w.team, async (tx) => {
      await tx.execute(
        sql`UPDATE runs SET status = 'cancelled', ended_at = now() WHERE id = ${w.runId}`,
      );
      await tx.execute(
        sql`INSERT INTO run_events (team_id, run_id, type, payload) VALUES (${w.team}, ${w.runId}, 'run.interrupted', ${JSON.stringify({ reason: "cancelled", last_entry_id: null, retryable: false })}::jsonb)`,
      );
    });
    const before = (await events(w.team, w.runId)).length;
    sb.event(w.runId, w.threadId, 2, delta("late"));
    await sb.until(() => sb.frames("error").find((e) => e.code === "run_not_active"));
    await sb.until(() => sb.acked(w.runId) >= 2);
    expect((await events(w.team, w.runId)).length).toBe(before);
    sb.send({
      v: 1,
      type: "policy.check",
      request_id: "r1",
      run_id: w.runId,
      thread_id: w.threadId,
      tool_call_id: "c1",
      tool: "read",
      input: { path: "/workspace/a" },
    });
    const result = await sb.until(() =>
      sb.frames("policy.result").find((r) => r.request_id === "r1"),
    );
    expect(result.decision).toBe("deny");
    expect(result.reasons.map((r) => r.code)).toEqual(["run_not_active"]);
    expect(sb.closed).toBeUndefined();
  });
});

describe("leasing and the compromised-sandbox suite", () => {
  it("closes with lease_violation for a run of another sandbox (forged run id) and audits it", async () => {
    const w = await world();
    const other = await newRun(w); // same team and user, but never started on this connection
    const sb = await connect(0, w);
    sb.event(other.runId, other.threadId, 1, { type: "agent_start" });
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.lease_violation);
    expect(sb.frames("error").map((e) => e.code)).toContain("unknown_run");
    await settled();
    expect(await auditActions(w.team)).toContain("sandbox.lease_violation");
    expect((await events(w.team, other.runId)).length).toBe(0);
  });

  it("closes for a random run id, a thread mismatch and an unknown command id", async () => {
    const w = await world();
    const a = await connect(0, w);
    a.send({
      v: 1,
      type: "policy.check",
      request_id: "r",
      run_id: randomUUID(),
      thread_id: randomUUID(),
      tool_call_id: "c",
      tool: "read",
      input: {},
    });
    expect((await a.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.lease_violation);
    const b = await started(w);
    b.event(w.runId, randomUUID(), 1, { type: "agent_start" });
    expect((await b.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.lease_violation);
    expect(b.frames("error").map((e) => e.code)).toContain("unknown_thread");
    const c = await connect(1, w, [{ run_id: w.runId, thread_id: w.threadId, last_seq: 0 }]);
    c.result("never-issued", true);
    expect((await c.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.lease_violation);
  });

  it("cannot reach another team's runs (cross-team isolation)", async () => {
    const w1 = await world();
    const w2 = await world();
    // w1's sandbox names w2's run: never leased → violation; nothing written in team 2.
    const sb = await connect(0, w1);
    sb.event(w2.runId, w2.threadId, 1, delta("x"));
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.lease_violation);
    expect((await events(w2.team, w2.runId)).length).toBe(0);
    // A token for team 1 + a team-2 run id in hello.runs is not listed (and not interrupted).
    const again = await connect(1, w1, [{ run_id: w2.runId, thread_id: w2.threadId, last_seq: 3 }]);
    expect(again.frames("hello.ack")[0]?.runs).toEqual([]);
    expect((await runRow(w2.team, w2.runId)).status).toBe("running");
    // Routing with team 1's id cannot address team 2's thread.
    const r = await fx.replica(0).deps.sandboxWire.router.startRun(w1.target, {
      runId: w2.runId,
      threadId: w2.threadId,
      message: "x",
    });
    expect(r).toMatchObject({ ok: false, error: { code: "thread_not_found" } });
  });

  it("answers hostile frames with malformed_frame and keeps the connection", async () => {
    const w = await world();
    const sb = await connect(0, w);
    sb.sendRaw('{"v":1,"type":"ping","nonce":"a","nonce":"b"}'); // duplicate keys
    sb.sendRaw('{"v":1,"type":"ping","nonce":"a","__proto__":{"x":1}}');
    sb.sendRaw(`${"[".repeat(200)}${"]".repeat(200)}`); // deep nesting
    sb.sendRaw("not json");
    sb.sendRaw('{"v":1,"type":"pi.event","run_id":"x"}');
    sb.socket.send(Buffer.from([1, 2, 3]), { binary: true });
    await sb.until(() => sb.frames("error").length >= 6);
    expect(new Set(sb.frames("error").map((e) => e.code))).toEqual(new Set(["malformed_frame"]));
    sb.send({ v: 1, type: "ping", nonce: "still-there" });
    await sb.until(() => sb.frames("pong").find((p) => p.nonce === "still-there"));
  });

  it("refuses oversized frames at the WebSocket layer", async () => {
    const w = await world();
    const sb = await connect(0, w);
    sb.sendRaw(`{"v":1,"type":"ping","nonce":"${"x".repeat(SANDBOX_MAX_FRAME_BYTES)}"}`);
    expect((await sb.waitClosed()).code).toBe(1009);
  });

  it("caps frame size by type before decoding: small types at 256 KiB, pi.event at 4 MiB", async () => {
    const w = await world();
    const sb = await connect(0, w);
    // A large frame whose type may be large is decoded (and here rejected as malformed).
    sb.sendRaw(`{"v":1,"type":"pi.event","junk":"${"x".repeat(300 * 1024)}"}`);
    await sb.until(() => sb.frames("error").find((e) => e.code === "malformed_frame"));
    expect(sb.closed).toBeUndefined();
    // The same size as a ping (or with an unreadable type) is refused unparsed.
    sb.sendRaw(`{"v":1,"type":"ping","nonce":"${"x".repeat(300 * 1024)}"}`);
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.protocol_error);
    await settled();
    expect(await auditActions(w.team)).toContain("sandbox.limit_exceeded");
  });

  it("closes a flooding sandbox", async () => {
    const w = await world();
    const sb = await connect(0, w);
    for (let i = 0; i < 1_000; i += 1) sb.send({ v: 1, type: "ping", nonce: `n${i}` });
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.protocol_error);
  });

  it("keeps exactly one connection when the same sandbox connects twice at once", async () => {
    const w = await world();
    const open = async (replica: number) => {
      const sb = await FakeSandbox.connect(url(replica), w.token);
      if (!isFake(sb)) throw new Error("refused");
      sandboxes.push(sb);
      return sb;
    };
    const [a, b, c] = await Promise.all([open(0), open(0), open(1)]);
    for (const sb of [a, b, c]) sb.hello(w.sandboxId);
    await expect
      .poll(
        () =>
          [a, b, c].filter((sb) => sb.closed === undefined && sb.frames("hello.ack").length > 0)
            .length,
        {
          timeout: 5_000,
        },
      )
      .toBe(1);
    await sleep(300);
    const alive = [a, b, c].filter((sb) => sb.closed === undefined);
    expect(alive).toHaveLength(1);
    const { rows } = await fx.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sandbox_connections WHERE team_id = $1 AND closed_at IS NULL`,
      [w.team],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("closes every connection of a deactivated user on every replica", async () => {
    const w = await world();
    const sb = await connect(1, w);
    await fx.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [w.owner.id]);
    await fx.replica(0).deps.lifecycle.emit("deactivated", w.owner.id);
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.unauthorized);
  });

  it("closes a removed member's connection in that team on every replica", async () => {
    const w = await world();
    const member = await fx.person("leaver");
    await fx.addMember(w.team, member);
    const sandboxId = randomUUID();
    const token = auth.issue({ sandboxId, teamId: w.team, userId: member.id });
    const sb = await FakeSandbox.connect(url(1), token);
    if (!isFake(sb)) throw new Error("refused");
    sandboxes.push(sb);
    sb.hello(sandboxId);
    await sb.ready();
    await fx.activate(w.owner, w.team);
    const res = await fx.replica(0).app.request(`http://kobe.test/v1/team/members/${member.id}`, {
      method: "DELETE",
      headers: {
        cookie: [...w.owner.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        origin: "http://kobe.test",
        "x-kobe-team": w.team,
        "x-forwarded-for": w.owner.browser.ip,
      },
    });
    expect(res.status).toBe(204);
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.unauthorized);
  });
});

describe("policy.check", () => {
  const check = (w: World, requestId: string, tool: string, input: Record<string, unknown>) => ({
    v: 1,
    type: "policy.check",
    request_id: requestId,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: `call-${requestId}`,
    tool,
    input,
  });

  it("allows a read, denies an unknown tool (with policy.denied), and denies approvals by default", async () => {
    const w = await world();
    const sb = await started(w);
    sb.send(check(w, "a", "read", { path: "notes.md" }));
    sb.send(check(w, "b", "rm_everything", {}));
    sb.send(check(w, "c", "create_artifact", { kind: "markdown", title: "x", content: "x" }));
    const res = (id: string) =>
      sb.until(() => sb.frames("policy.result").find((r) => r.request_id === id));
    expect((await res("a")).decision).toBe("allow");
    const unknown = await res("b");
    expect(unknown).toMatchObject({ decision: "deny", reasons: [{ code: "unknown_tool" }] });
    const approval = await res("c");
    expect(approval.decision).toBe("deny");
    expect(approval.decision === "deny" && approval.message).toMatch(/approval/);
    await expect
      .poll(
        async () =>
          (await events(w.team, w.runId)).filter((e) => e.type === "policy.denied").length,
      )
      .toBe(2);
  });

  it("answers a request id once, even when the sandbox replays it", async () => {
    const w = await world();
    const sb = await started(w);
    sb.send(check(w, "dup", "read", { path: "a" }));
    await sb.until(() => sb.frames("policy.result").find((r) => r.request_id === "dup"));
    sb.send(check(w, "dup", "read", { path: "a" }));
    sb.send(check(w, "after", "read", { path: "b" }));
    await sb.until(() => sb.frames("policy.result").find((r) => r.request_id === "after"));
    expect(sb.frames("policy.result").filter((r) => r.request_id === "dup")).toHaveLength(1);
  });

  it("applies the install approval floor (no team floor, D6) and fails closed on an invalid one", async () => {
    const w = await world();
    const sb = await started(w);
    const decide = async (id: string) => {
      sb.send(check(w, id, "read", { path: "x" }));
      return sb.until(() => sb.frames("policy.result").find((r) => r.request_id === id));
    };
    expect((await decide("f0")).decision).toBe("allow");
    // Teams have no approval floor (spec D6): a leftover team setting changes nothing.
    await fx.admin.query(
      `UPDATE teams SET settings = settings || '{"approval_mode_floor":"ask-all"}' WHERE id = $1`,
      [w.team],
    );
    expect((await decide("f1")).decision).toBe("allow");
    await fx.admin.query(`UPDATE teams SET settings = '{}' WHERE id = $1`, [w.team]);
    const setFloor = (value: string) =>
      fx.admin.query(
        `INSERT INTO install_settings (key, value) VALUES ('policy.approval_floor', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [value],
      );
    try {
      // Install floor ask-all: even a read needs approval (denied by the default broker).
      await setFloor("ask-all");
      const install = await decide("f2");
      expect(install.decision === "deny" && install.message).toMatch(/approval/);
      // An unreadable floor is the strictest mode: fail closed.
      await setFloor("yolo");
      expect((await decide("f3")).decision).toBe("deny");
    } finally {
      await fx.admin.query(`DELETE FROM install_settings WHERE key = 'policy.approval_floor'`);
    }
    expect((await decide("f4")).decision).toBe("allow");
  });

  it("denies when the user is no longer a team member", async () => {
    const w = await world();
    const sb = await started(w);
    await fx.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      w.team,
      w.owner.id,
    ]);
    sb.send(check(w, "m", "read", { path: "a" }));
    const r = await sb.until(() => sb.frames("policy.result").find((x) => x.request_id === "m"));
    expect(r.decision).toBe("deny");
    expect(r.reasons.map((x) => x.code)).toEqual(["not_a_member"]);
  });
});

describe("session restore (lost volume)", () => {
  it("restores Pi's session from Postgres before the next run when Pi no longer has our last entry", async () => {
    const w = await world();
    const t = new Date().toISOString();
    await withTeam(fx.db, w.team, (tx) =>
      tx.execute(sql`
        INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload) VALUES
          (${w.team}, ${w.threadId}, 'e1', NULL, 'message', ${JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: t })}::jsonb),
          (${w.team}, ${w.threadId}, 'e2', 'e1', 'message', ${JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: t })}::jsonb)`),
    );
    const sb = await connect(0, w); // fresh volume: empty session
    const r = await fx.replica(1).deps.sandboxWire.router.startRun(w.target, {
      runId: w.runId,
      threadId: w.threadId,
      message: "again",
    });
    expect(r).toEqual({ ok: true });
    expect(sb.restored.at(-1)?.final).toBe(true);
    expect(sb.session.map((e) => e.id)).toEqual(["e1", "e2"]);
    const order = sb.received.map((f) => f.type).filter((t) => t !== "ping");
    expect(order.indexOf("session.restore")).toBeLessThan(order.indexOf("run.start"));
  });
});

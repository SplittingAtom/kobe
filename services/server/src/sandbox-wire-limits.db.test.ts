import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITY_SESSION_RENEW, SANDBOX_CLOSE_CODES } from "@kobe/protocol";
import { EventStreamFixture, must } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";

/**
 * Sandbox wire limits with aggressive timings (KOBE-24): heartbeat timeout, periodic revalidation
 * of the sandbox's liveness, and per-run backpressure (frames past the memory cap are dropped and
 * fetched again with `resend`, never lost and never stored twice).
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
let listener: Awaited<ReturnType<typeof sandboxListener>>;
const sandboxes: FakeSandbox[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await fx.setup([{}], () => ({
    sandboxWire: {
      sweep: false,
      tuning: {
        heartbeatIntervalMs: 200,
        heartbeatTimeoutMs: 700,
        revalidateMs: 300,
        batchWindowMs: 10,
        batchMaxFrames: 5,
        runQueueMaxBytes: 2_000,
        tokenExpiryGraceMs: 200,
        internalCommandTimeoutMs: 500,
        byteRatePerSec: 256 * 1024,
        runMaxEvents: 60,
        runMaxBytes: 50 * 1024,
        threadMaxEntries: 5,
        deniedEventBurst: 2,
        deniedEventsPerMinute: 1,
        byteBurst: 512 * 1024,
      },
    },
  }));
  listener = await sandboxListener(fx.replica(0).deps, auth);
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  await listener.close();
  await fx.teardown();
});

async function setup() {
  const owner = await fx.person(`l${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`l-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE id = $1`,
    [runId],
  );
  const threadId = must(rows[0], "run").thread_id;
  const sandboxId = randomUUID();
  const token = auth.issue({ sandboxId, teamId: team, userId: owner.id });
  const sb = await FakeSandbox.connect(listener.url, token);
  if (!isFake(sb)) throw new Error("refused");
  sandboxes.push(sb);
  sb.hello(sandboxId);
  await sb.ready();
  // The agent's outbox (KOBE-23): everything sent is re-sent from `from_seq` on `resend`.
  const sent = new Map<string, Map<number, Record<string, unknown>>>();
  const event = sb.event.bind(sb);
  sb.event = (run, thread, seq, ev) => {
    const frames = sent.get(run) ?? new Map<number, Record<string, unknown>>();
    frames.set(seq, ev);
    sent.set(run, frames);
    event(run, thread, seq, ev);
  };
  sb.onFrame = (f) => {
    if (f.type !== "resend") return;
    const frames = sent.get(f.run_id);
    if (!frames) return;
    for (const [seq, ev] of [...frames].sort((a, b) => a[0] - b[0])) {
      if (seq >= f.from_seq) event(f.run_id, threadId, seq, ev);
    }
  };
  return { owner, team, runId, threadId, sandboxId, sb };
}

describe("heartbeats and revalidation", () => {
  it("closes a connection when its session token expires (plus grace)", async () => {
    const owner = await fx.person(`x${randomBytes(2).toString("hex")}`);
    const team = await fx.team(`x-${randomBytes(3).toString("hex")}`, owner);
    const sandboxId = randomUUID();
    const token = auth.issue({ sandboxId, teamId: team, userId: owner.id }, 2);
    const sb = await FakeSandbox.connect(listener.url, token);
    if (!isFake(sb)) throw new Error("refused");
    sandboxes.push(sb);
    sb.hello(sandboxId);
    await sb.ready();
    const keepAlive = setInterval(() => sb.send({ v: 1, type: "ping", nonce: "k" }), 100);
    try {
      expect((await sb.waitClosed(6_000)).code).toBe(SANDBOX_CLOSE_CODES.unauthorized);
    } finally {
      clearInterval(keepAlive);
    }
  });

  async function shortLived(capabilities: readonly string[] = [CAPABILITY_SESSION_RENEW]) {
    const owner = await fx.person(`r${randomBytes(2).toString("hex")}`);
    const team = await fx.team(`r-${randomBytes(3).toString("hex")}`, owner);
    const sandboxId = randomUUID();
    const claims = { sandboxId, teamId: team, userId: owner.id };
    const sb = await FakeSandbox.connect(listener.url, auth.issue(claims, 2));
    if (!isFake(sb)) throw new Error("refused");
    sandboxes.push(sb);
    sb.hello(sandboxId, [], "1.0.0", capabilities);
    await sb.ready();
    return { sb, claims };
  }

  it("keeps a connection whose agent renews its session token in band (KOBE-483)", async () => {
    const { sb, claims } = await shortLived();
    // Every 2-s token is renewed before it expires: routine expiry never closes the connection.
    const keepAlive = setInterval(() => sb.send({ v: 1, type: "ping", nonce: "k" }), 100);
    const renew = setInterval(
      () => sb.send({ v: 1, type: "session.renew", token: auth.issue(claims, 2) }),
      700,
    );
    try {
      await sleep(4_500);
      expect(sb.closed).toBeUndefined();
    } finally {
      clearInterval(renew);
      clearInterval(keepAlive);
    }
    // Renewals stop: the last token's expiry (plus grace) closes it, as before.
    const stillAlive = setInterval(() => sb.send({ v: 1, type: "ping", nonce: "k" }), 100);
    try {
      expect((await sb.waitClosed(6_000)).code).toBe(SANDBOX_CLOSE_CODES.unauthorized);
    } finally {
      clearInterval(stillAlive);
    }
  });

  it("ignores an invalid renewal and closes on a token of another identity (KOBE-483)", async () => {
    const { sb, claims } = await shortLived();
    sb.send({ v: 1, type: "ping", nonce: "k" });
    sb.send({ v: 1, type: "session.renew", token: "tok-not-issued-by-the-server-0000" });
    await sleep(300);
    expect(sb.closed).toBeUndefined();
    const other = auth.issue({ ...claims, sandboxId: randomUUID() }, 900);
    sb.send({ v: 1, type: "session.renew", token: other });
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.unauthorized);
  });

  it("closes after three invalid renewals (KOBE-483 review)", async () => {
    const { sb } = await shortLived();
    sb.send({ v: 1, type: "ping", nonce: "k" });
    for (let i = 0; i < 2; i++)
      sb.send({ v: 1, type: "session.renew", token: `tok-not-issued-by-the-server-000${i}` });
    await sleep(200);
    expect(sb.closed).toBeUndefined();
    sb.send({ v: 1, type: "session.renew", token: "tok-not-issued-by-the-server-0002" });
    expect((await sb.waitClosed(1_000)).code).toBe(SANDBOX_CLOSE_CODES.unauthorized);
  });

  it("revalidates on renewal: a removed member's renewal closes the connection (KOBE-483 review)", async () => {
    const { sb, claims } = await shortLived();
    sb.send({ v: 1, type: "ping", nonce: "k" });
    await fx.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      claims.teamId,
      claims.userId,
    ]);
    sb.send({ v: 1, type: "session.renew", token: auth.issue(claims, 900) });
    // Well before the 300 ms periodic revalidation and the 2 s token's expiry.
    expect((await sb.waitClosed(250)).code).toBe(SANDBOX_CLOSE_CODES.unauthorized);
  });

  it("does not renew for an agent that did not announce session_renew (KOBE-483)", async () => {
    const { sb, claims } = await shortLived([]);
    const renew = setInterval(() => {
      sb.send({ v: 1, type: "ping", nonce: "k" });
      sb.send({ v: 1, type: "session.renew", token: auth.issue(claims, 2) });
    }, 100);
    try {
      expect((await sb.waitClosed(6_000)).code).toBe(SANDBOX_CLOSE_CODES.unauthorized);
    } finally {
      clearInterval(renew);
    }
  });

  it("closes a silent sandbox with heartbeat_timeout, after pinging it", async () => {
    const { sb } = await setup();
    expect((await sb.waitClosed(5_000)).code).toBe(SANDBOX_CLOSE_CODES.heartbeat_timeout);
    expect(sb.frames("ping").length).toBeGreaterThan(0);
  });

  it("closes with sandbox_destroyed once the sandbox is no longer live", async () => {
    const { sb, sandboxId } = await setup();
    const keepAlive = setInterval(() => sb.send({ v: 1, type: "ping", nonce: "k" }), 100);
    auth.dead.add(sandboxId);
    try {
      expect((await sb.waitClosed(5_000)).code).toBe(SANDBOX_CLOSE_CODES.sandbox_destroyed);
    } finally {
      clearInterval(keepAlive);
    }
  });
});

async function startRun(w: Awaited<ReturnType<typeof setup>>) {
  const r = await fx
    .replica(0)
    .deps.sandboxWire.router.startRun(
      { teamId: w.team, userId: w.owner.id },
      { runId: w.runId, threadId: w.threadId, message: "go" },
    );
  expect(r).toEqual({ ok: true });
}

async function runState(runId: string) {
  const { rows } = await fx.admin.query<{ status: string }>(
    `SELECT status FROM runs WHERE id = $1`,
    [runId],
  );
  const events = await fx.admin.query<{ type: string; payload: Record<string, unknown> }>(
    `SELECT type, payload FROM run_events WHERE run_id = $1 ORDER BY seq`,
    [runId],
  );
  return { status: rows[0]?.status, events: events.rows };
}

describe("storage caps (compromised sandbox)", () => {
  it("fails and stops a run that exceeds its event cap, within the cap", async () => {
    const w = await setup();
    const keepAlive = setInterval(() => w.sb.send({ v: 1, type: "ping", nonce: "k" }), 100);
    try {
      await startRun(w);
      for (let seq = 1; seq <= 80; seq += 1) {
        w.sb.event(w.runId, w.threadId, seq, {
          type: "tool_execution_start",
          toolCallId: `c${seq}`,
          toolName: "read",
          args: { path: "a" },
        });
      }
      await expect
        .poll(async () => (await runState(w.runId)).status, { timeout: 10_000 })
        .toBe("failed");
      const { events } = await runState(w.runId);
      expect(events.length).toBeLessThanOrEqual(60);
      expect(events.at(-1)).toMatchObject({
        type: "run.failed",
        payload: { error: { code: "run_too_large" } },
      });
      await w.sb.until(() => w.sb.frames("run.stop").find((f) => f.run_id === w.runId));
      const audit = await fx.admin.query(
        `SELECT 1 FROM audit_log WHERE team_id = $1 AND action = 'sandbox.limit_exceeded'`,
        [w.team],
      );
      expect(audit.rowCount).toBeGreaterThan(0);
    } finally {
      clearInterval(keepAlive);
    }
  });

  it("fails a run whose stored bytes exceed the cap", async () => {
    const w = await setup();
    const keepAlive = setInterval(() => w.sb.send({ v: 1, type: "ping", nonce: "k" }), 100);
    try {
      await startRun(w);
      w.sb.event(w.runId, w.threadId, 1, {
        type: "tool_execution_start",
        toolCallId: "big",
        toolName: "write",
        args: { path: "f", content: "z".repeat(60 * 1024) },
      });
      await expect
        .poll(async () => (await runState(w.runId)).status, { timeout: 10_000 })
        .toBe("failed");
      expect((await runState(w.runId)).events.map((e) => e.type)).toEqual(["run.failed"]);
    } finally {
      clearInterval(keepAlive);
    }
  });

  it("stops mirroring at the thread entry cap and fails the run", async () => {
    const w = await setup();
    const keepAlive = setInterval(() => w.sb.send({ v: 1, type: "ping", nonce: "k" }), 100);
    try {
      await startRun(w);
      const t = new Date().toISOString();
      w.sb.session = Array.from({ length: 8 }, (_, i) => ({
        type: "message",
        id: `e${i}`,
        parentId: i === 0 ? null : `e${i - 1}`,
        timestamp: t,
      }));
      w.sb.event(w.runId, w.threadId, 1, { type: "turn_end", message: { role: "assistant" } });
      await expect
        .poll(async () => (await runState(w.runId)).status, { timeout: 10_000 })
        .toBe("failed");
      const { rows } = await fx.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM thread_entries WHERE thread_id = $1`,
        [w.threadId],
      );
      expect(rows[0]?.n).toBeLessThanOrEqual(5);
      expect((await runState(w.runId)).events.at(-1)).toMatchObject({
        payload: { error: { code: "thread_too_large" } },
      });
    } finally {
      clearInterval(keepAlive);
    }
  });

  it("rate-limits policy.denied events per run (every call is still denied)", async () => {
    const w = await setup();
    const keepAlive = setInterval(() => w.sb.send({ v: 1, type: "ping", nonce: "k" }), 100);
    try {
      await startRun(w);
      for (let i = 0; i < 8; i += 1) {
        w.sb.send({
          v: 1,
          type: "policy.check",
          request_id: `d${i}`,
          run_id: w.runId,
          thread_id: w.threadId,
          tool_call_id: `c${i}`,
          tool: "no_such_tool",
          input: {},
        });
      }
      await w.sb.until(() => w.sb.frames("policy.result").length >= 8);
      expect(w.sb.frames("policy.result").every((r) => r.decision === "deny")).toBe(true);
      const denied = (await runState(w.runId)).events.filter((e) => e.type === "policy.denied");
      expect(denied.length).toBe(2);
    } finally {
      clearInterval(keepAlive);
    }
  });
});

describe("late results", () => {
  it("treats a result after the command timed out as late, not as a lease violation", async () => {
    const w = await setup();
    const keepAlive = setInterval(() => w.sb.send({ v: 1, type: "ping", nonce: "k" }), 100);
    let withheld: string | undefined;
    w.sb.respond = (f) => {
      if (f.type === "pi.command" && f.command.type === "get_entries") {
        withheld = f.command_id;
        return null; // swallowed: answered late below
      }
      return undefined;
    };
    try {
      const r = await fx
        .replica(0)
        .deps.sandboxWire.router.startRun(
          { teamId: w.team, userId: w.owner.id },
          { runId: w.runId, threadId: w.threadId, message: "go" },
        );
      expect(r).toMatchObject({ ok: false, error: { code: "session_unavailable" } });
      w.sb.result(must(withheld, "get_entries id"), true, { entries: [], leafId: null });
      w.sb.send({ v: 1, type: "ping", nonce: "after" });
      await w.sb.until(() => w.sb.frames("pong").find((p) => p.nonce === "after"));
      expect(w.sb.closed).toBeUndefined();
    } finally {
      clearInterval(keepAlive);
    }
  });
});

describe("byte budget", () => {
  it("closes a sandbox that sends more bytes than its budget, before decoding them", async () => {
    const { sb } = await setup();
    const big = `{"v":1,"type":"ping","nonce":"${"y".repeat(200 * 1024)}"}`;
    for (let i = 0; i < 6; i += 1) sb.sendRaw(big);
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.protocol_error);
  });
});

describe("backpressure", () => {
  it("drops frames past the per-run memory cap and recovers them with resend, exactly once", async () => {
    const w = await setup();
    const { sb } = w;
    const keepAlive = setInterval(() => sb.send({ v: 1, type: "ping", nonce: "k" }), 100);
    const r = await fx
      .replica(0)
      .deps.sandboxWire.router.startRun(
        { teamId: w.team, userId: w.owner.id },
        { runId: w.runId, threadId: w.threadId, message: "go" },
      );
    expect(r).toEqual({ ok: true });
    const N = 120;
    const frames = new Map<number, Record<string, unknown>>();
    const usage = {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { total: 0 },
    };
    frames.set(1, { type: "message_start", message: { role: "assistant" } });
    for (let seq = 2; seq <= N; seq += 1) {
      frames.set(seq, {
        type: "message_update",
        usage,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `<${seq}>` },
      });
    }
    // The agent's outbox: re-send everything from `from_seq` when asked (KOBE-23 behaviour).
    sb.onFrame = (f) => {
      if (f.type !== "resend" || f.run_id !== w.runId) return;
      for (let seq = f.from_seq; seq <= N; seq += 1) {
        sb.event(w.runId, w.threadId, seq, must(frames.get(seq), "frame"));
      }
    };
    for (let seq = 1; seq <= N; seq += 1)
      sb.event(w.runId, w.threadId, seq, must(frames.get(seq), "frame"));
    try {
      await sb.until(() => sb.acked(w.runId) >= N, 20_000);
    } finally {
      clearInterval(keepAlive);
    }
    expect(sb.frames("resend").length).toBeGreaterThan(0);
    const { rows } = await fx.admin.query<{ payload: { delta: string } }>(
      `SELECT payload FROM run_events WHERE run_id = $1 AND type = 'text.delta' ORDER BY seq`,
      [w.runId],
    );
    const expected = Array.from({ length: N - 1 }, (_, i) => `<${i + 2}>`).join("");
    expect(rows.map((x) => x.payload.delta).join("")).toBe(expected);
    const run = await fx.admin.query<{ sandbox_seq: number }>(
      `SELECT sandbox_seq FROM runs WHERE id = $1`,
      [w.runId],
    );
    expect(run.rows[0]?.sandbox_seq).toBe(N);
  });
});

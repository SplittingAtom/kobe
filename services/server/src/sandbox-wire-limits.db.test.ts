import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SANDBOX_CLOSE_CODES } from "@kobe/protocol";
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
  return { owner, team, runId, threadId, sandboxId, sb };
}

describe("heartbeats and revalidation", () => {
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

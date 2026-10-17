import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAPABILITY_TRACE_SPANS,
  SANDBOX_CLOSE_CODES,
  parseTraceparent,
  runRootSpanId,
  runTraceId,
} from "@kobe/protocol";
import { deriveTraceSpanKey, mapSandboxSpanId } from "@kobe/protocol/node";
import { InMemorySpanExporter, initTelemetry, spanRelay, type Telemetry } from "@kobe/telemetry";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";

/**
 * Relayed sandbox spans over the real wire (KOBE-274 ac-2/ac-3/ac-6): trace context on run.start
 * for agents that announce `trace_spans`, spans exported in the run's trace with server-stamped
 * identity, and malformed, oversized, foreign-run and late frames refused or dropped.
 */
const KEY = deriveTraceSpanKey(new TextEncoder().encode("t".repeat(40)));
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const own = new InMemorySpanExporter();
const relayed = new InMemorySpanExporter();
const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
const sandboxes: FakeSandbox[] = [];
let telemetry: Telemetry | undefined;

beforeAll(async () => {
  telemetry = initTelemetry(
    {
      enabled: true,
      endpoint: "http://x:4318",
      headers: {},
      captureContent: false,
      serviceName: "t",
    },
    {
      exporter: own,
      relayExporter: relayed,
      relayQueue: { maxQueue: 1000, batchSize: 100, intervalMs: 60_000 },
    },
  );
  // Replica 1 relays no spans (no `k_trace`): tracing off for sandbox spans there (ac-5).
  await fx.setup([{}, {}], (replica) => ({
    sandboxWire: {
      sweep: false,
      ...(replica === 0 ? { traceSpanKey: KEY } : {}),
      tuning: {
        batchWindowMs: 20,
        resultPollMs: 200,
        lostGraceMs: 0,
        helloTimeoutMs: 1_000,
        frameBurst: 400,
        frameRatePerSec: 100,
        upgradeBurst: 1_000,
        upgradeRatePerSec: 100,
      },
    },
  }));
  listeners.push(await sandboxListener(fx.replica(0).deps, auth));
  listeners.push(await sandboxListener(fx.replica(1).deps, auth));
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  for (const l of listeners) await l.close();
  await fx.teardown();
  await telemetry?.shutdown();
});

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly runId: string;
  readonly threadId: string;
  readonly sandboxId: string;
  readonly token: string;
}

async function world(): Promise<World> {
  const owner = await fx.person(`u${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`tr-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  const threadId = must(rows[0], "run").thread_id;
  const sandboxId = randomUUID();
  const token = auth.issue({ sandboxId, teamId: team, userId: owner.id });
  return { team, owner, runId, threadId, sandboxId, token };
}

async function connect(
  w: World,
  options: {
    holder?: number;
    capabilities?: string[];
    runs?: { run_id: string; thread_id: string; last_seq: number }[];
    headers?: Record<string, string>;
  } = {},
) {
  const sb = await FakeSandbox.connect(
    must(listeners[options.holder ?? 0], "listener").url,
    w.token,
    options.headers ? { headers: options.headers } : {},
  );
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(
    w.sandboxId,
    options.runs ?? [],
    "1.0.0",
    options.capabilities ?? [CAPABILITY_TRACE_SPANS],
  );
  await sb.ready();
  return sb;
}

async function started(w: World, capabilities: string[] = [CAPABILITY_TRACE_SPANS], holder = 0) {
  const sb = await connect(w, { capabilities, holder });
  const result = await fx
    .replica(1 - holder)
    .deps.sandboxWire.router.startRun(
      { teamId: w.team, userId: w.owner.id },
      { runId: w.runId, threadId: w.threadId, message: "hello" },
    );
  expect(result).toEqual({ ok: true });
  const start = must(sb.frames("run.start")[0], "run.start");
  return { sb, start };
}

const T = () => Date.now();
const runSpan = (parent: string, over: Record<string, unknown> = {}) => ({
  span_id: "1111111111111111",
  parent_span_id: parent,
  name: "sandbox.run",
  start_ms: T() - 50,
  end_ms: T(),
  status: "ok",
  attributes: { "kobe.run.outcome": "completed" },
  ...over,
});

async function waitExported(runId: string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const spans = await exportedFor(runId);
    if (spans.length > 0) return spans;
    if (Date.now() > deadline) throw new Error("no relayed span");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function exportedFor(runId: string) {
  await spanRelay()?.flush();
  return relayed.getFinishedSpans().filter((s) => s.spanContext().traceId === runTraceId(runId));
}

describe("trace.spans over the wire (KOBE-274)", () => {
  it("hands a traced agent the run's trace context and exports its spans in that trace", async () => {
    const w = await world();
    const { sb, start } = await started(w);
    const tp = parseTraceparent(must(start.trace, "trace").traceparent);
    expect(tp?.traceId).toBe(runTraceId(w.runId));
    expect(start.trace?.capture_content).toBe(false);
    const command = own
      .getFinishedSpans()
      .find((s) => s.name === "sandbox.command" && s.spanContext().spanId === tp?.parentSpanId);
    expect(command?.parentSpanContext?.spanId).toBe(runRootSpanId(w.runId));
    expect(command?.attributes).toMatchObject({ "session.id": w.threadId, "user.id": w.owner.id });

    sb.send({
      v: 1,
      type: "trace.spans",
      run_id: w.runId,
      thread_id: w.threadId,
      spans: [runSpan(must(tp, "tp").parentSpanId)],
    });
    const [span] = await waitExported(w.runId);
    expect(span?.spanContext().spanId).toBe(mapSandboxSpanId(KEY, w.runId, "1111111111111111"));
    expect(span?.parentSpanContext?.spanId).toBe(tp?.parentSpanId);
    expect(span?.attributes).toMatchObject({
      "kobe.team_id": w.team,
      "kobe.thread_id": w.threadId,
      "kobe.run_id": w.runId,
      "kobe.sandbox_id": w.sandboxId,
      "session.id": w.threadId,
      "user.id": w.owner.id,
    });
    expect(sb.closed).toBeUndefined();
  });

  it("sends no trace context to an agent without the capability and ignores its span frames", async () => {
    const w = await world();
    const { sb, start } = await started(w, []);
    expect(start.trace).toBeUndefined();
    sb.send({
      v: 1,
      type: "trace.spans",
      run_id: w.runId,
      thread_id: w.threadId,
      spans: [runSpan("aaaaaaaaaaaaaaaa")],
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(await exportedFor(w.runId)).toHaveLength(0);
    expect(sb.closed).toBeUndefined();
    expect(sb.frames("error")).toHaveLength(0);
  });

  it("answers a malformed envelope with malformed_frame and drops bad spans silently", async () => {
    const w = await world();
    const { sb, start } = await started(w);
    const parent = must(
      parseTraceparent(must(start.trace, "trace").traceparent),
      "tp",
    ).parentSpanId;
    sb.send({ v: 1, type: "trace.spans", run_id: w.runId, thread_id: w.threadId, spans: [] });
    await sb.until(() => sb.frames("error").find((e) => e.code === "malformed_frame"));
    sb.send({
      v: 1,
      type: "trace.spans",
      run_id: w.runId,
      thread_id: w.threadId,
      spans: [{ name: "sandbox.http" }, runSpan(parent, { attributes: { "user.id": "forged" } })],
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(await exportedFor(w.runId)).toHaveLength(0);
    expect(sb.frames("error")).toHaveLength(1);
    expect(sb.closed).toBeUndefined();
  });

  it("closes on an oversized span frame", async () => {
    const w = await world();
    const { sb } = await started(w);
    sb.sendRaw(
      `{"v":1,"type":"trace.spans","run_id":"${w.runId}","thread_id":"${w.threadId}","spans":["${"x".repeat(300 * 1024)}"]}`,
    );
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.protocol_error);
  });

  it("closes with lease_violation for a run this connection never held", async () => {
    const w = await world();
    const other = await world();
    const { sb } = await started(w);
    sb.send({
      v: 1,
      type: "trace.spans",
      run_id: other.runId,
      thread_id: other.threadId,
      spans: [runSpan("aaaaaaaaaaaaaaaa")],
    });
    expect((await sb.waitClosed()).code).toBe(SANDBOX_CLOSE_CODES.lease_violation);
    expect(await exportedFor(other.runId)).toHaveLength(0);
  });

  it("takes a span frame after the run ended (grace) without an error or a close", async () => {
    const w = await world();
    const { sb, start } = await started(w);
    const parent = must(
      parseTraceparent(must(start.trace, "trace").traceparent),
      "tp",
    ).parentSpanId;
    const events = [
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_end", message: { role: "assistant" } },
      { type: "turn_end", message: { role: "assistant" } },
      { type: "agent_settled" },
    ];
    events.forEach((e, i) => sb.event(w.runId, w.threadId, i + 1, e));
    await sb.until(() => sb.acked(w.runId) >= events.length);
    await new Promise((r) => setTimeout(r, 200));
    sb.send({
      v: 1,
      type: "trace.spans",
      run_id: w.runId,
      thread_id: w.threadId,
      spans: [runSpan(parent)],
    });
    await waitExported(w.runId);
    expect(sb.frames("error")).toHaveLength(0);
    expect(sb.closed).toBeUndefined();
  });

  it("rate-limits span frames by their decoded type, whatever the key order (review SF1)", async () => {
    const w = await world();
    const { sb, start } = await started(w);
    const parent = must(
      parseTraceparent(must(start.trace, "trace").traceparent),
      "tp",
    ).parentSpanId;
    const before = fx.replica(0).deps.sandboxWire.metrics().traceFramesDropped;
    for (let i = 0; i < 40; i++) {
      const span = runSpan(parent, { span_id: (i + 1).toString(16).padStart(16, "0") });
      // `type` before `v`: no prefix sniffing can classify this frame.
      sb.sendRaw(
        JSON.stringify({
          type: "trace.spans",
          v: 1,
          run_id: w.runId,
          thread_id: w.threadId,
          spans: [span],
        }),
      );
    }
    await waitExported(w.runId);
    await new Promise((r) => setTimeout(r, 300));
    const exported = await exportedFor(w.runId);
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.length).toBeLessThan(30);
    expect(fx.replica(0).deps.sandboxWire.metrics().traceFramesDropped - before).toBeGreaterThan(0);
    expect(sb.closed).toBeUndefined();
  });

  it("keeps a run's seen-set across a reconnect: a reused span id is not exported again (review SF3)", async () => {
    const w = await world();
    const { sb, start } = await started(w);
    const parent = must(
      parseTraceparent(must(start.trace, "trace").traceparent),
      "tp",
    ).parentSpanId;
    const send = (s: FakeSandbox, spans: unknown[]) =>
      s.send({ v: 1, type: "trace.spans", run_id: w.runId, thread_id: w.threadId, spans });
    send(sb, [runSpan(parent)]);
    await waitExported(w.runId);
    sb.close();
    await sb.waitClosed();
    const again = await connect(w, {
      runs: [{ run_id: w.runId, thread_id: w.threadId, last_seq: 0 }],
    });
    expect((await again.ready()).runs.map((r) => r.run_id)).toContain(w.runId);
    send(again, [
      runSpan(parent),
      runSpan(parent, {
        span_id: "2222222222222222",
        name: "sandbox.turn",
        attributes: { "kobe.turn.index": 0 },
      }),
    ]);
    const deadline = Date.now() + 5_000;
    while ((await exportedFor(w.runId)).length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 200));
    const ids = (await exportedFor(w.runId)).map((s) => s.spanContext().spanId).sort();
    expect(ids).toEqual(
      [
        mapSandboxSpanId(KEY, w.runId, "1111111111111111"),
        mapSandboxSpanId(KEY, w.runId, "2222222222222222"),
      ].sort(),
    );
    // The command span the run started under is still known after the reconnect.
    const turn = (await exportedFor(w.runId)).find((s) => s.name === "sandbox.turn");
    expect(turn?.parentSpanContext?.spanId).toBe(parent);
  });

  it("with sandbox span relay off on the replica, sends no trace context and ignores span frames (ac-5)", async () => {
    const w = await world();
    const { sb, start } = await started(w, [CAPABILITY_TRACE_SPANS], 1);
    expect(start.trace).toBeUndefined();
    sb.send({
      v: 1,
      type: "trace.spans",
      run_id: w.runId,
      thread_id: w.threadId,
      spans: [runSpan("aaaaaaaaaaaaaaaa")],
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(await exportedFor(w.runId)).toHaveLength(0);
    expect(sb.frames("error")).toHaveLength(0);
    expect(sb.closed).toBeUndefined();
  });

  it("the WebSocket upgrade never joins a sandbox's traceparent (listener rule)", async () => {
    const w = await world();
    const caller = runTraceId(w.runId);
    await connect(w, { headers: { traceparent: `00-${caller}-${runRootSpanId(w.runId)}-01` } });
    const upgrades = own.getFinishedSpans().filter((s) => s.name === "sandbox.ws.upgrade");
    expect(upgrades.length).toBeGreaterThan(0);
    expect(upgrades.every((s) => s.spanContext().traceId !== caller)).toBe(true);
  });
});

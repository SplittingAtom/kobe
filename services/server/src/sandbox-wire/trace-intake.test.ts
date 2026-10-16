import { runRootSpanId, runTraceId, type TraceSpansFrame } from "@kobe/protocol";
import { deriveTraceSpanKey, mapSandboxSpanId } from "@kobe/protocol/node";
import type { RelaySpan, RunRootSpan } from "@kobe/telemetry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayBudget } from "./trace-budget.js";
import { TraceFrameRate, TraceIntake, type TraceCounters } from "./trace-intake.js";

const TEAM = "0b6f1c2e-6d1a-4c56-9a43-1f0e2d3c4b5a";
const USER = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const THREAD = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60";
const RUN = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071";
const SANDBOX = "af1a2b3c-4d5e-4f60-9182-93a4b5c6d7e8";
const COMMAND = "c0c0c0c0c0c0c0c0";
const KEY = deriveTraceSpanKey(new TextEncoder().encode("k".repeat(32)));
const T0 = 1_792_000_000_000;
const map = (id: string) => mapSandboxSpanId(KEY, RUN, id);
const OWNER = { teamId: TEAM, userId: USER, sandboxId: SANDBOX };

afterEach(() => {
  vi.useRealTimers();
});

function setup(over: { captureContent?: boolean; budget?: RelayBudget; now?: () => number } = {}) {
  const exported: RelaySpan[] = [];
  const roots: RunRootSpan[] = [];
  const counters: TraceCounters = {
    traceSpansRelayed: 0,
    traceSpansDropped: 0,
    traceFramesDropped: 0,
  };
  let now = T0;
  const intake = new TraceIntake({
    key: KEY,
    budget: over.budget ?? new RelayBudget(),
    counters,
    captureContent: over.captureContent ?? false,
    offer: (spans) => {
      exported.push(...spans);
      return spans.length;
    },
    recordRoot: (root) => roots.push(root),
    now: over.now ?? (() => now),
  });
  intake.track(RUN, THREAD, new Date(T0), OWNER);
  intake.traced(RUN, COMMAND);
  return {
    intake,
    exported,
    roots,
    counters,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const span = (over: Record<string, unknown> = {}) => ({
  span_id: "1111111111111111",
  parent_span_id: COMMAND,
  name: "sandbox.run",
  start_ms: T0 + 10,
  end_ms: T0 + 500,
  status: "ok",
  attributes: { "kobe.run.outcome": "completed" },
  ...over,
});
const tool = (over: Record<string, unknown> = {}) =>
  span({
    span_id: "2222222222222222",
    parent_span_id: "1111111111111111",
    name: "sandbox.tool",
    attributes: {
      "kobe.tool.call_id": "call_1",
      "kobe.tool.outcome": "ok",
      "kobe.tool.input": "SECRET INPUT",
      "kobe.tool.output": "SECRET OUTPUT",
    },
    ...over,
  });
const frame = (spans: unknown[], over: Partial<TraceSpansFrame> = {}): TraceSpansFrame => ({
  v: 1,
  type: "trace.spans",
  run_id: RUN,
  thread_id: THREAD,
  spans,
  ...over,
});

describe("TraceIntake (KOBE-274)", () => {
  it("exports spans in the run's trace with remapped ids and server-stamped identity", () => {
    const { intake, exported, counters } = setup();
    intake.noteToolCall(RUN, "call_1", "bash");
    intake.accept(frame([span(), tool()]), OWNER);
    expect(counters.traceSpansRelayed).toBe(2);
    const [run, call] = exported;
    expect(run).toMatchObject({
      name: "sandbox.run",
      traceId: runTraceId(RUN),
      spanId: map("1111111111111111"),
      parentSpanId: COMMAND,
    });
    expect(run?.attributes).toMatchObject({
      "kobe.team_id": TEAM,
      "kobe.user_id": USER,
      "kobe.thread_id": THREAD,
      "kobe.run_id": RUN,
      "kobe.sandbox_id": SANDBOX,
      "session.id": THREAD,
      "user.id": USER,
    });
    expect(call?.parentSpanId).toBe(map("1111111111111111"));
    expect(call?.attributes).toMatchObject({
      "kobe.tool.name": "bash",
      "kobe.tool.call_id": "call_1",
    });
  });

  it("strips content at intake with capture off, keeps it with capture on (ac-4)", () => {
    const off = setup();
    off.intake.accept(frame([tool()]), OWNER);
    expect(JSON.stringify(off.exported)).not.toMatch(/SECRET/);
    const on = setup({ captureContent: true });
    on.intake.accept(frame([tool()]), OWNER);
    expect(on.exported[0]?.attributes["kobe.tool.input"]).toBe("SECRET INPUT");
  });

  it("names a tool only from the server's decision; an unknown call id is dropped", () => {
    const { intake, exported } = setup();
    intake.accept(frame([tool()]), OWNER);
    expect(exported[0]?.attributes["kobe.tool.name"]).toBe("unknown");
    expect(exported[0]?.attributes).not.toHaveProperty("kobe.tool.call_id");
  });

  it("drops invalid spans one by one, duplicates across frames, and counts them", () => {
    const { intake, exported, counters, roots, advance } = setup();
    intake.accept(frame([span(), { junk: true }, span({ span_id: "ZZ" })], { dropped: 4 }), OWNER);
    intake.accept(frame([span()]), OWNER);
    expect(exported).toHaveLength(1);
    expect(counters.traceSpansDropped).toBe(3);
    intake.ended(RUN);
    advance(31_000);
    intake.close();
    expect(roots[0]?.attributes["kobe.trace.sandbox_spans_dropped"]).toBe(7);
  });

  it("refuses spans that would close a cycle and reparents a misparented run span", () => {
    const { intake, exported } = setup();
    intake.accept(
      frame([
        span({
          span_id: "aaaaaaaaaaaaaaaa",
          parent_span_id: "bbbbbbbbbbbbbbbb",
          name: "sandbox.turn",
          attributes: { "kobe.turn.index": 0 },
        }),
        span({
          span_id: "bbbbbbbbbbbbbbbb",
          parent_span_id: "aaaaaaaaaaaaaaaa",
          name: "sandbox.turn",
          attributes: { "kobe.turn.index": 1 },
        }),
        span({ span_id: "1111111111111111", parent_span_id: "9999999999999999" }),
      ]),
      OWNER,
    );
    expect(exported.map((s) => s.spanId)).toEqual([
      map("aaaaaaaaaaaaaaaa"),
      map("1111111111111111"),
    ]);
    expect(exported[1]?.parentSpanId).toBe(COMMAND);
  });

  it("clamps times to the run window and drops spans that end before they start", () => {
    const { intake, exported } = setup();
    intake.accept(
      frame([
        span({ start_ms: 1e12, end_ms: T0 + 100 }),
        span({ span_id: "3333333333333333", start_ms: T0 + 9e9, end_ms: T0 + 9e9 }),
      ]),
      OWNER,
    );
    expect(exported[0]?.startMs).toBe(T0 - 60_000);
    expect(exported[1]?.startMs).toBe(T0 + 60_000);
    expect(exported[1]?.endMs).toBe(T0 + 60_000);
  });

  it("takes nothing for a run started without a trace context or a foreign thread", () => {
    const { intake, exported, counters } = setup();
    const other = "9e8d7c6b-5a49-4382-b170-6f5e4d3c2b1a";
    intake.track(other, THREAD, null, OWNER);
    intake.accept(frame([span()], { run_id: other }), OWNER);
    intake.accept(frame([span()], { thread_id: other }), OWNER);
    expect(exported).toHaveLength(0);
    expect(counters.traceFramesDropped).toBe(2);
  });

  it("respects the replica budget and the per-connection frame rate", () => {
    const budget = new RelayBudget(
      { perSecond: 1, burst: 4, teamShare: 0.5, maxTeams: 4 },
      () => T0,
    );
    const { intake, exported } = setup({ budget });
    intake.accept(
      frame([0, 1, 2, 3].map((i) => span({ span_id: `${i + 1}`.padStart(16, "0") }))),
      OWNER,
    );
    expect(exported).toHaveLength(2);
    const rate = new TraceFrameRate(
      intake.tuning,
      {
        traceSpansRelayed: 0,
        traceSpansDropped: 0,
        traceFramesDropped: 0,
      },
      () => T0,
    );
    let admitted = 0;
    for (let i = 0; i < 30; i++) if (rate.admit()) admitted++;
    expect(admitted).toBe(20);
  });

  it("records the run's root after the grace period, with identity, and forgets the run", () => {
    vi.useFakeTimers();
    const { intake, roots } = setup({ now: () => Date.now() });
    intake.ended(RUN);
    expect(intake.recentlyEnded(RUN, THREAD, OWNER)).toBe(true);
    expect(roots).toHaveLength(0);
    vi.advanceTimersByTime(30_000);
    expect(roots[0]).toMatchObject({
      runId: RUN,
      startMs: T0,
      attributes: { "session.id": THREAD, "user.id": USER, "kobe.run_id": RUN },
    });
    expect(intake.recentlyEnded(RUN, THREAD, OWNER)).toBe(false);
    expect(runRootSpanId(RUN)).toHaveLength(16);
  });
});

describe("TraceIntake per replica (KOBE-274 review SF3, N1, N4)", () => {
  it("keeps a run's seen-set and command spans when the run is leased again (reconnect)", () => {
    const { intake, exported } = setup();
    intake.accept(frame([span()]), OWNER);
    intake.track(RUN, THREAD, new Date(T0), { ...OWNER, sandboxId: SANDBOX });
    intake.accept(frame([span(), span({ span_id: "5555555555555555" })]), OWNER);
    expect(exported.map((s) => s.spanId)).toEqual([
      map("1111111111111111"),
      map("5555555555555555"),
    ]);
    expect(exported[1]?.parentSpanId).toBe(COMMAND);
  });

  it("takes nothing for a run of another team, whatever the frame says", () => {
    const { intake, exported } = setup();
    intake.accept(frame([span()]), { ...OWNER, teamId: "9e8d7c6b-5a49-4382-b170-6f5e4d3c2b1a" });
    expect(exported).toHaveLength(0);
  });

  it("caps the agent's reported drop count per run", () => {
    const { intake, roots } = setup();
    intake.accept(frame([span()], { dropped: 1_000_000 }), OWNER);
    intake.accept(frame([span({ span_id: "6666666666666666" })], { dropped: 1_000_000 }), OWNER);
    intake.ended(RUN);
    intake.close();
    expect(roots[0]?.attributes["kobe.trace.sandbox_spans_dropped"]).toBe(100_000);
  });

  it("exports a decided call id only when it is a plain id", () => {
    const { intake, exported } = setup();
    const odd = "call with spaces: the secret plan";
    intake.noteToolCall(RUN, odd, "bash");
    intake.accept(
      frame([tool({ attributes: { "kobe.tool.call_id": odd, "kobe.tool.outcome": "ok" } })]),
      OWNER,
    );
    expect(exported[0]?.attributes["kobe.tool.name"]).toBe("bash");
    expect(exported[0]?.attributes).not.toHaveProperty("kobe.tool.call_id");
  });
});

describe("RelayBudget", () => {
  it("caps one team at its share and refills over time", () => {
    let now = 0;
    const budget = new RelayBudget(
      { perSecond: 100, burst: 100, teamShare: 0.25, maxTeams: 8 },
      () => now,
    );
    expect(budget.take("a", 100)).toBe(25);
    expect(budget.take("b", 100)).toBe(25);
    expect(budget.take("a", 1)).toBe(0);
    now += 1000;
    expect(budget.take("a", 100)).toBe(25);
  });
});

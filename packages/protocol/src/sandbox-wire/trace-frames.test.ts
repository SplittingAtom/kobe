import { describe, expect, it } from "vitest";
import {
  SANDBOX_SPAN_ATTRIBUTES,
  SANDBOX_SPAN_CONTENT_MAX_CHARS,
  SANDBOX_SPAN_MAX_ATTRIBUTES,
  SANDBOX_SPAN_NAMES,
  TRACE_SPANS_AGENT_SEND_AFTER_END_MS,
  TRACE_SPANS_FRAME_MAX_BYTES,
  TRACE_SPANS_LATE_GRACE_MS,
  TRACE_SPANS_PER_FRAME_MAX,
  decodeSandboxFrame,
  decodeServerFrame,
  encodeFrame,
  formatTraceparent,
  parseSandboxSpan,
  runRootSpanId,
  runTraceId,
  traceSpansFrameSchema,
} from "../index.js";
import { EXAMPLE_IDS } from "../testing/index.js";

const RUN = EXAMPLE_IDS.run;
const THREAD = EXAMPLE_IDS.thread;
const T0 = 1_792_000_000_000;

const runSpan = {
  span_id: "1111111111111111",
  parent_span_id: "aaaaaaaaaaaaaaaa",
  name: "sandbox.run",
  start_ms: T0,
  end_ms: T0 + 5_000.25,
  status: "ok",
  attributes: { "kobe.run.outcome": "completed", "kobe.turns": 2 },
};
const toolSpan = {
  span_id: "2222222222222222",
  parent_span_id: "1111111111111111",
  name: "sandbox.tool",
  start_ms: T0 + 10,
  end_ms: T0 + 20,
  status: "error",
  error_type: "tool_error",
  attributes: { "kobe.tool.call_id": "call_1", "kobe.tool.outcome": "error" },
};
const frame = {
  v: 1,
  type: "trace.spans",
  run_id: RUN,
  thread_id: THREAD,
  spans: [runSpan, toolSpan],
};

const decode = (value: unknown) => decodeSandboxFrame(JSON.stringify(value));
const valid = (span: unknown) => parseSandboxSpan(span) !== undefined;

/** KOBE-274: sandbox → server span frames and the run's trace context. */
describe("trace.spans envelope (sandbox → server)", () => {
  it("decodes with spans left for the server to parse one by one", () => {
    const withBad = { ...frame, dropped: 3, spans: [runSpan, { junk: true }, toolSpan] };
    expect(decode(withBad)).toEqual({ ok: true, frame: withBad });
  });

  it("is strict: no trace id, team, user or session on the envelope", () => {
    for (const key of ["trace_id", "team_id", "user_id", "session_id", "sandbox_id"]) {
      expect(decode({ ...frame, [key]: "x" }).ok, key).toBe(false);
    }
  });

  it("limits spans per frame, refuses an empty batch and a bad dropped counter", () => {
    const many = Array.from({ length: TRACE_SPANS_PER_FRAME_MAX + 1 }, () => runSpan);
    expect(traceSpansFrameSchema.safeParse({ ...frame, spans: many.slice(1) }).success).toBe(true);
    expect(traceSpansFrameSchema.safeParse({ ...frame, spans: many }).success).toBe(false);
    expect(traceSpansFrameSchema.safeParse({ ...frame, spans: [] }).success).toBe(false);
    expect(traceSpansFrameSchema.safeParse({ ...frame, dropped: -1 }).success).toBe(false);
    expect(traceSpansFrameSchema.safeParse({ ...frame, dropped: 1.5 }).success).toBe(false);
  });

  it("keeps a frame of maximal content spans splittable under the small-frame cap", () => {
    const fat = {
      ...toolSpan,
      attributes: {
        ...toolSpan.attributes,
        "kobe.tool.input": "\u0001".repeat(SANDBOX_SPAN_CONTENT_MAX_CHARS),
        "kobe.tool.output": "\u0001".repeat(SANDBOX_SPAN_CONTENT_MAX_CHARS),
      },
    };
    expect(valid(fat)).toBe(true);
    const one = encodeFrame(traceSpansFrameSchema.parse({ ...frame, spans: [fat] }));
    expect(new TextEncoder().encode(one).byteLength).toBeLessThan(TRACE_SPANS_FRAME_MAX_BYTES);
  });

  it("has the agent stop sending before the server's grace ends", () => {
    expect(TRACE_SPANS_AGENT_SEND_AFTER_END_MS).toBeLessThan(TRACE_SPANS_LATE_GRACE_MS);
  });
});

describe("sandbox spans (parsed one by one)", () => {
  it("accepts run, turn, tool, compaction and sync spans", () => {
    for (const span of [
      runSpan,
      {
        ...runSpan,
        span_id: "3333333333333333",
        name: "sandbox.turn",
        attributes: { "kobe.turn.index": 0, "kobe.stop_reason": "tool_use", "kobe.tool_calls": 1 },
      },
      toolSpan,
      {
        ...runSpan,
        name: "sandbox.compaction",
        attributes: { "kobe.compaction.trigger": "threshold", "kobe.compaction.tokens_before": 1 },
      },
      {
        ...runSpan,
        name: "sandbox.workspace_sync",
        attributes: { "kobe.sync.direction": "push", "kobe.sync.files": 2, "kobe.sync.bytes": 10 },
      },
    ]) {
      expect(parseSandboxSpan(span), span.name).toEqual(span);
    }
  });

  it("carries no identity, trace id or tool name: the server stamps those", () => {
    for (const key of [
      "trace_id",
      "team_id",
      "session.id",
      "user.id",
      "kobe.run_id",
      "kobe.tool.name",
    ]) {
      expect(valid({ ...runSpan, [key]: "x" }), key).toBe(false);
      expect(valid({ ...toolSpan, attributes: { ...toolSpan.attributes, [key]: "x" } }), key).toBe(
        false,
      );
    }
  });

  it("allows only each name's own attributes, and no token counts", () => {
    expect(valid({ ...toolSpan, name: "sandbox.run" })).toBe(false);
    expect(valid({ ...runSpan, name: "sandbox.http" })).toBe(false);
    const usage = { ...runSpan.attributes, "gen_ai.usage.input_tokens": 5 };
    expect(valid({ ...runSpan, attributes: usage })).toBe(false);
  });

  it("keeps every span name under the attribute count limit", () => {
    expect(SANDBOX_SPAN_NAMES).toHaveLength(5);
    for (const name of SANDBOX_SPAN_NAMES) {
      const keys = Object.keys(SANDBOX_SPAN_ATTRIBUTES[name].shape);
      expect(keys.length, name).toBeLessThanOrEqual(SANDBOX_SPAN_MAX_ATTRIBUTES);
    }
  });

  it("uses closed codes: no free-form error type or stop reason", () => {
    const turn = { ...runSpan, name: "sandbox.turn", attributes: { "kobe.turn.index": 0 } };
    expect(
      valid({ ...turn, attributes: { "kobe.turn.index": 0, "kobe.stop_reason": "other" } }),
    ).toBe(true);
    expect(
      valid({ ...turn, attributes: { "kobe.turn.index": 0, "kobe.stop_reason": "hello" } }),
    ).toBe(false);
    expect(valid({ ...toolSpan, error_type: "other" })).toBe(true);
    expect(valid({ ...toolSpan, error_type: "secret_leak_here" })).toBe(false);
  });

  it("caps content sizes", () => {
    const at = (extra: Record<string, unknown>) => ({
      ...toolSpan,
      attributes: { ...toolSpan.attributes, ...extra },
    });
    const max = "x".repeat(SANDBOX_SPAN_CONTENT_MAX_CHARS);
    expect(valid(at({ "kobe.tool.input": max }))).toBe(true);
    expect(valid(at({ "kobe.tool.output": `${max}x` }))).toBe(false);
  });

  it("rejects bad ids, implausible or reversed times and status combinations", () => {
    for (const bad of [
      { span_id: "0000000000000000" },
      { span_id: "ABCDEFABCDEFABCD" },
      { parent_span_id: "1111" },
      { parent_span_id: runSpan.span_id },
      { end_ms: T0 - 1 },
      { start_ms: 1e-300 },
      { start_ms: 0 },
      { end_ms: 8.64e15 },
      { start_ms: "1" },
      { error_type: "pi_exited" },
      { status: "unset" },
    ]) {
      expect(valid({ ...runSpan, ...bad }), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("trace context (server → sandbox)", () => {
  const trace = {
    traceparent: formatTraceparent(runTraceId(RUN), "aaaaaaaaaaaaaaaa"),
    capture_content: false,
  };
  const start = {
    v: 1,
    type: "run.start",
    command_id: "c1",
    run_id: RUN,
    thread_id: THREAD,
    message: "hi",
  };
  const compact = {
    v: 1,
    type: "thread.compact",
    command_id: "c2",
    thread_id: THREAD,
    run_id: RUN,
    model: { alias: "fast", gateway_model: "ollama/qwen3", api: "openai-completions" },
    run_token: { token: "krt1.abc", expires_at: "2026-10-14T12:00:00Z" },
  };

  it("is optional on run.start and thread.compact", () => {
    for (const f of [start, compact, { ...start, trace }, { ...compact, trace }]) {
      expect(decodeServerFrame(JSON.stringify(f))).toEqual({ ok: true, frame: f });
    }
  });

  it("drops unknown keys, so a future field never fails a run on an older agent", () => {
    const future = { ...start, trace: { ...trace, tracestate: "x=y" } };
    expect(decodeServerFrame(JSON.stringify(future))).toEqual({
      ok: true,
      frame: { ...start, trace },
    });
  });

  it("requires a valid traceparent and the capture flag", () => {
    for (const bad of [
      { ...trace, traceparent: "00-abc-def-01" },
      { traceparent: trace.traceparent },
    ]) {
      expect(decodeServerFrame(JSON.stringify({ ...start, trace: bad })).ok).toBe(false);
    }
  });

  it("is not on steer or stop (the trace is fixed at the run's start)", () => {
    const steer = {
      v: 1,
      type: "run.steer",
      command_id: "c3",
      run_id: RUN,
      thread_id: THREAD,
      message: "x",
    };
    expect(decodeServerFrame(JSON.stringify({ ...steer, trace })).ok).toBe(false);
  });

  it("the run's root span id is a valid parent id", () => {
    expect(valid({ ...runSpan, parent_span_id: runRootSpanId(RUN) })).toBe(true);
  });
});

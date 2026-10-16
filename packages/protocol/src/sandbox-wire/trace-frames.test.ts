import { describe, expect, it } from "vitest";
import {
  SANDBOX_SPAN_ATTRIBUTES,
  SANDBOX_SPAN_CONTENT_MAX_CHARS,
  SANDBOX_SPAN_MAX_ATTRIBUTES,
  SANDBOX_SPAN_MAX_DURATION_MS,
  SANDBOX_SPAN_NAMES,
  TRACE_SPANS_FRAME_MAX_BYTES,
  TRACE_SPANS_PER_FRAME_MAX,
  decodeSandboxFrame,
  decodeServerFrame,
  encodeFrame,
  formatTraceparent,
  runRootSpanId,
  runTraceId,
  sandboxSpanSchema,
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
  attributes: {
    "kobe.tool.name": "bash",
    "kobe.tool.call_id": "call_1",
    "kobe.tool.outcome": "error",
  },
};
const frame = {
  v: 1,
  type: "trace.spans",
  run_id: RUN,
  thread_id: THREAD,
  spans: [runSpan, toolSpan],
};

const decode = (value: unknown) => decodeSandboxFrame(JSON.stringify(value));

/** KOBE-274: sandbox → server span frames and the run's trace context. */
describe("trace.spans (sandbox → server)", () => {
  it("decodes a batch of run, turn, tool, compaction and sync spans", () => {
    const all = {
      ...frame,
      dropped: 3,
      spans: [
        runSpan,
        {
          ...runSpan,
          span_id: "3333333333333333",
          parent_span_id: "1111111111111111",
          name: "sandbox.turn",
          attributes: {
            "kobe.turn.index": 0,
            "kobe.stop_reason": "tool_use",
            "kobe.tool_calls": 1,
          },
        },
        toolSpan,
        {
          ...runSpan,
          span_id: "4444444444444444",
          name: "sandbox.compaction",
          attributes: {
            "kobe.compaction.trigger": "threshold",
            "kobe.compaction.tokens_before": 1,
          },
        },
        {
          ...runSpan,
          span_id: "5555555555555555",
          name: "sandbox.workspace_sync",
          attributes: {
            "kobe.sync.direction": "push",
            "kobe.sync.files": 2,
            "kobe.sync.bytes": 10,
          },
        },
      ],
    };
    expect(decode(all)).toEqual({ ok: true, frame: all });
  });

  it("carries no trace id, team, user or session: the server stamps those", () => {
    expect(decode({ ...frame, trace_id: runTraceId(RUN) }).ok).toBe(false);
    for (const key of ["trace_id", "team_id", "user_id", "session.id", "user.id", "kobe.run_id"]) {
      expect(sandboxSpanSchema.safeParse({ ...runSpan, [key]: "x" }).success, key).toBe(false);
      const attributes = { ...runSpan.attributes, [key]: "x" };
      expect(sandboxSpanSchema.safeParse({ ...runSpan, attributes }).success, key).toBe(false);
    }
  });

  it("allows only each name's own attributes", () => {
    const wrong = { ...toolSpan, name: "sandbox.run" };
    expect(sandboxSpanSchema.safeParse(wrong).success).toBe(false);
    expect(sandboxSpanSchema.safeParse({ ...runSpan, name: "sandbox.http" }).success).toBe(false);
    const usage = { ...runSpan.attributes, "gen_ai.usage.input_tokens": 5 };
    expect(sandboxSpanSchema.safeParse({ ...runSpan, attributes: usage }).success).toBe(false);
  });

  it("keeps every span name under the attribute count limit", () => {
    expect(SANDBOX_SPAN_NAMES).toHaveLength(5);
    for (const name of SANDBOX_SPAN_NAMES) {
      const keys = Object.keys(SANDBOX_SPAN_ATTRIBUTES[name].shape);
      expect(keys.length, name).toBeLessThanOrEqual(SANDBOX_SPAN_MAX_ATTRIBUTES);
    }
  });

  it("caps content and metadata attribute sizes", () => {
    const at = (extra: Record<string, unknown>) => ({
      ...toolSpan,
      attributes: { ...toolSpan.attributes, ...extra },
    });
    const max = "x".repeat(SANDBOX_SPAN_CONTENT_MAX_CHARS);
    expect(sandboxSpanSchema.safeParse(at({ "kobe.tool.input": max })).success).toBe(true);
    expect(sandboxSpanSchema.safeParse(at({ "kobe.tool.output": `${max}x` })).success).toBe(false);
    expect(sandboxSpanSchema.safeParse(at({ "kobe.tool.name": "t".repeat(257) })).success).toBe(
      false,
    );
  });

  it("rejects bad ids, times and status combinations", () => {
    for (const bad of [
      { span_id: "0000000000000000" },
      { span_id: "ABCDEFABCDEFABCD" },
      { parent_span_id: "1111" },
      { parent_span_id: runSpan.span_id },
      { end_ms: T0 - 1 },
      { end_ms: T0 + SANDBOX_SPAN_MAX_DURATION_MS + 1 },
      { start_ms: 0 },
      { error_type: "pi_exited" },
      { error_type: "Has Spaces", status: "error" },
      { status: "unset" },
    ]) {
      expect(sandboxSpanSchema.safeParse({ ...runSpan, ...bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
    expect(decode({ ...frame, spans: [{ ...runSpan, start_ms: "1" }] }).ok).toBe(false);
  });

  it("limits spans per frame and refuses empty batches and duplicate span ids", () => {
    const many = Array.from({ length: TRACE_SPANS_PER_FRAME_MAX + 1 }, (_, i) => ({
      ...runSpan,
      span_id: (i + 1).toString(16).padStart(16, "0"),
    }));
    expect(traceSpansFrameSchema.safeParse({ ...frame, spans: many.slice(1) }).success).toBe(true);
    expect(traceSpansFrameSchema.safeParse({ ...frame, spans: many }).success).toBe(false);
    expect(traceSpansFrameSchema.safeParse({ ...frame, spans: [] }).success).toBe(false);
    expect(traceSpansFrameSchema.safeParse({ ...frame, spans: [runSpan, runSpan] }).success).toBe(
      false,
    );
    expect(traceSpansFrameSchema.safeParse({ ...frame, dropped: -1 }).success).toBe(false);
  });

  it("fits a full frame of maximal content spans only after splitting: frames stay small", () => {
    const fat = {
      ...toolSpan,
      attributes: {
        ...toolSpan.attributes,
        "kobe.tool.input": "\u0001".repeat(SANDBOX_SPAN_CONTENT_MAX_CHARS),
        "kobe.tool.output": "\u0001".repeat(SANDBOX_SPAN_CONTENT_MAX_CHARS),
      },
    };
    const one = encodeFrame(traceSpansFrameSchema.parse({ ...frame, spans: [fat] }));
    expect(new TextEncoder().encode(one).byteLength).toBeLessThan(TRACE_SPANS_FRAME_MAX_BYTES);
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

  it("is strict: a bad traceparent or an extra key fails the command frame", () => {
    for (const bad of [
      { ...trace, traceparent: "00-abc-def-01" },
      { ...trace, tracestate: "x=y" },
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

  it("root span id of the run is a valid parent for the sandbox's run span", () => {
    const span = { ...runSpan, parent_span_id: runRootSpanId(RUN) };
    expect(sandboxSpanSchema.safeParse(span).success).toBe(true);
  });
});

import {
  decodeSandboxFrame,
  formatTraceparent,
  parseSandboxSpan,
  runTraceId,
  type SandboxSpan,
  type TraceSpansFrame,
} from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { TraceRecorder } from "./recorder.js";

const RUN = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071";
const THREAD = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60";
const COMMAND = "c0c0c0c0c0c0c0c0";
const trace = (capture = false) => ({
  traceparent: formatTraceparent(runTraceId(RUN), COMMAND),
  capture_content: capture,
});

let recorders: TraceRecorder[] = [];
afterEach(() => {
  for (const r of recorders) r.close();
  recorders = [];
});

function setup(over: { connected?: boolean; bufferMax?: number } = {}) {
  const frames: TraceSpansFrame[] = [];
  const parents: (string | null)[] = [];
  let now = 1_792_000_000_000;
  let connected = over.connected ?? true;
  const recorder = new TraceRecorder({
    sendText: (text) => {
      if (!connected) return false;
      const decoded = decodeSandboxFrame(text);
      if (!decoded.ok || decoded.frame.type !== "trace.spans") throw new Error("bad frame");
      frames.push(decoded.frame);
      return true;
    },
    onModelParent: (_run, tp) => parents.push(tp),
    now: () => now,
    flushIntervalMs: 60_000,
    ...(over.bufferMax === undefined ? {} : { bufferMax: over.bufferMax }),
  });
  recorders.push(recorder);
  const spans = (): SandboxSpan[] =>
    frames.flatMap((f) => f.spans.map((s) => parseSandboxSpan(s) as SandboxSpan));
  return {
    recorder,
    frames,
    parents,
    spans,
    tick: (ms: number) => {
      now += ms;
    },
    connect: () => {
      connected = true;
    },
  };
}

function aRun(recorder: TraceRecorder, tick: (ms: number) => void, capture = false) {
  recorder.startRun(RUN, THREAD, trace(capture));
  recorder.onPiEvent(RUN, { type: "agent_start" });
  recorder.onPiEvent(RUN, { type: "turn_start" });
  tick(5);
  recorder.onPiEvent(RUN, {
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "bash",
    args: { command: "cat secret.txt" },
  });
  tick(5);
  recorder.onPiEvent(RUN, {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "TOP SECRET" }] },
    isError: false,
  });
  recorder.onPiEvent(RUN, {
    type: "message_end",
    message: { role: "assistant", stopReason: "toolUse" },
  });
  recorder.onPiEvent(RUN, { type: "turn_end" });
  recorder.onPiEvent(RUN, { type: "agent_end" });
  tick(5);
  recorder.runEnded(RUN);
}

describe("TraceRecorder (KOBE-274)", () => {
  it("records nothing for a run without a trace context", () => {
    const { recorder, frames, parents } = setup();
    recorder.startRun(RUN, THREAD, undefined);
    recorder.onPiEvent(RUN, { type: "turn_start" });
    recorder.runEnded(RUN);
    recorder.flush();
    expect(frames).toEqual([]);
    expect(parents).toEqual([]);
    expect(recorder.runIds).toEqual([]);
  });

  it("builds run → turn → tool spans and sends them in one valid frame at run end", () => {
    const { recorder, frames, spans, parents, tick } = setup();
    aRun(recorder, tick);
    expect(frames).toHaveLength(1);
    const byName = Object.fromEntries(spans().map((s) => [s.name, s]));
    const run = byName["sandbox.run"];
    const turn = byName["sandbox.turn"];
    const tool = byName["sandbox.tool"];
    expect(run?.parent_span_id).toBe(COMMAND);
    expect(run?.attributes).toEqual({ "kobe.run.outcome": "completed", "kobe.turns": 1 });
    expect(turn?.parent_span_id).toBe(run?.span_id);
    expect(turn?.attributes).toEqual({
      "kobe.turn.index": 0,
      "kobe.stop_reason": "tool_use",
      "kobe.tool_calls": 1,
    });
    expect(tool?.parent_span_id).toBe(turn?.span_id);
    expect(tool?.attributes).toEqual({ "kobe.tool.call_id": "call_1", "kobe.tool.outcome": "ok" });
    expect(JSON.stringify(frames)).not.toMatch(/secret|SECRET|bash/);
    // Model calls go under the run, then the turn, then the run again, then nothing.
    expect(parents).toEqual([
      formatTraceparent(runTraceId(RUN), run?.span_id ?? ""),
      formatTraceparent(runTraceId(RUN), turn?.span_id ?? ""),
      formatTraceparent(runTraceId(RUN), run?.span_id ?? ""),
      null,
    ]);
  });

  it("answers the run's current span for the model file: run, its turn, run again, none", () => {
    const { recorder, spans, tick } = setup();
    expect(recorder.modelParentOf(RUN)).toBeNull();
    recorder.startRun(RUN, THREAD, trace());
    const atStart = recorder.modelParentOf(RUN);
    recorder.onPiEvent(RUN, { type: "turn_start" });
    const inTurn = recorder.modelParentOf(RUN);
    recorder.onPiEvent(RUN, { type: "turn_end" });
    const afterTurn = recorder.modelParentOf(RUN);
    tick(10);
    recorder.runEnded(RUN);
    recorder.flush();
    expect(recorder.modelParentOf(RUN)).toBeNull();
    const run = spans().find((s) => s.name === "sandbox.run");
    const turn = spans().find((s) => s.name === "sandbox.turn");
    expect([atStart, inTurn, afterTurn]).toEqual([
      formatTraceparent(runTraceId(RUN), run?.span_id ?? ""),
      formatTraceparent(runTraceId(RUN), turn?.span_id ?? ""),
      formatTraceparent(runTraceId(RUN), run?.span_id ?? ""),
    ]);
  });

  it("adds tool content only with capture on", () => {
    const { recorder, spans, tick } = setup();
    recorder.startRun(RUN, THREAD, trace(true));
    aRun(recorder, tick, true);
    const tool = spans().find((s) => s.name === "sandbox.tool");
    expect(tool?.attributes["kobe.tool.input"]).toContain("cat secret.txt");
    expect(tool?.attributes["kobe.tool.output"]).toContain("TOP SECRET");
  });

  it("marks a denied call blocked and a stopped run aborted", () => {
    const { recorder, spans } = setup();
    recorder.startRun(RUN, THREAD, trace());
    recorder.onPiEvent(RUN, { type: "tool_execution_start", toolCallId: "c9" });
    recorder.noteDecision(RUN, "c9", "deny");
    recorder.onPiEvent(RUN, { type: "tool_execution_end", toolCallId: "c9", isError: true });
    recorder.stopRequested(RUN);
    recorder.runEnded(RUN);
    const tool = spans().find((s) => s.name === "sandbox.tool");
    expect(tool).toMatchObject({ status: "error", error_type: "blocked" });
    expect(tool?.attributes["kobe.tool.outcome"]).toBe("blocked");
    expect(spans().find((s) => s.name === "sandbox.run")?.attributes["kobe.run.outcome"]).toBe(
      "aborted",
    );
  });

  it("drops and counts spans past its buffer, and reports the count in the next frame", () => {
    const { recorder, frames, tick } = setup({ connected: false, bufferMax: 2 });
    aRun(recorder, tick);
    expect(frames).toHaveLength(0);
    expect(recorder.runIds).toEqual([RUN]);
    const connected = setup({ bufferMax: 2 });
    aRun(connected.recorder, connected.tick);
    expect(connected.frames[0]?.spans).toHaveLength(2);
    expect(connected.frames[0]?.dropped).toBe(1);
  });

  it("forgets runs the server no longer lists, and stops sending after the cut-off", () => {
    const a = setup({ connected: false });
    aRun(a.recorder, a.tick);
    a.recorder.keepOnly(new Set());
    a.connect();
    a.recorder.flush();
    expect(a.frames).toEqual([]);
    const b = setup({ connected: false });
    aRun(b.recorder, b.tick);
    b.tick(21_000);
    b.connect();
    b.recorder.flush();
    expect(b.frames).toEqual([]);
    expect(b.recorder.runIds).toEqual([]);
  });

  it("sends at most one frame per run per flush, 64 spans each", () => {
    const { recorder, frames } = setup();
    recorder.startRun(RUN, THREAD, trace());
    for (let i = 0; i < 70; i++) {
      recorder.onPiEvent(RUN, { type: "tool_execution_start", toolCallId: `c${i}` });
      recorder.onPiEvent(RUN, { type: "tool_execution_end", toolCallId: `c${i}` });
    }
    recorder.flush();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.spans).toHaveLength(64);
    recorder.flush();
    expect(frames[1]?.spans).toHaveLength(6);
  });

  it("records a compaction command as one compaction span", () => {
    const { recorder, spans } = setup();
    recorder.startRun(RUN, THREAD, trace(), true);
    recorder.onPiEvent(RUN, { type: "compaction_start", reason: "manual" });
    recorder.onPiEvent(RUN, {
      type: "compaction_end",
      reason: "manual",
      result: { tokensBefore: 1234 },
      aborted: false,
    });
    recorder.runEnded(RUN);
    expect(spans()).toHaveLength(1);
    expect(spans()[0]).toMatchObject({
      name: "sandbox.compaction",
      parent_span_id: COMMAND,
      attributes: { "kobe.compaction.trigger": "command", "kobe.compaction.tokens_before": 1234 },
    });
  });
});

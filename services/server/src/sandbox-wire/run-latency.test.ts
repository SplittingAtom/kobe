import { describe, expect, it } from "vitest";
import { RunLatency, toolNameAttribute, type LatencySpan } from "./run-latency.js";

const T0 = 1_792_000_000_000;

function setup(over: { resumed?: boolean; compaction?: boolean; maxOpenTools?: number } = {}) {
  const spans: LatencySpan[] = [];
  const latency = new RunLatency({
    startMs: T0,
    resumed: over.resumed ?? false,
    compaction: over.compaction ?? false,
    emit: (span) => spans.push(span),
    ...(over.maxOpenTools === undefined ? {} : { maxOpenTools: over.maxOpenTools }),
  });
  return { spans, latency };
}

const delta = { type: "text.delta", payload: { message_id: "m1", delta: "hi" } };
const reasoning = { type: "reasoning.delta", payload: { message_id: "m1", delta: "hm" } };
const call = (id: string, tool = "bash") => ({
  type: "tool.call",
  payload: { tool_call_id: id, tool },
});
const result = (id: string, isError = false) => ({
  type: "tool.result",
  payload: { tool_call_id: id, tool: "bash", is_error: isError },
});

describe("RunLatency (KOBE-525)", () => {
  it("records run.start → first Pi frame (Pi ready) once, even when the frame has no events", () => {
    const { spans, latency } = setup();
    latency.observe([], T0 + 800);
    latency.observe([], T0 + 900);
    expect(spans).toEqual([
      {
        name: "run.pi_ready",
        startMs: T0,
        endMs: T0 + 800,
        attributes: { "kobe.run.kind": "run" },
      },
    ]);
  });

  it("records run.start → first model token once; reasoning counts as the first token", () => {
    const { spans, latency } = setup();
    latency.observe([], T0 + 100);
    latency.observe([reasoning], T0 + 1_500);
    latency.observe([delta], T0 + 2_000);
    const first = spans.filter((s) => s.name === "run.first_token");
    expect(first).toEqual([
      {
        name: "run.first_token",
        startMs: T0,
        endMs: T0 + 1_500,
        attributes: { "kobe.run.kind": "run", "kobe.token.kind": "reasoning" },
      },
    ]);
  });

  it("skips start-relative spans for a resumed run (its start went out on another connection)", () => {
    const { spans, latency } = setup({ resumed: true });
    latency.observe([delta], T0 + 100);
    expect(spans).toEqual([]);
  });

  it("tags compaction runs", () => {
    const { spans, latency } = setup({ compaction: true });
    latency.observe([delta], T0 + 100);
    expect(spans.map((s) => s.attributes["kobe.run.kind"])).toEqual(["compaction", "compaction"]);
  });

  it("pairs tool.call with tool.result into a tool-call round trip", () => {
    const { spans, latency } = setup({ resumed: true });
    latency.observe([call("c1"), call("c2", "read")], T0 + 1_000);
    latency.observe([result("c2", true)], T0 + 1_200);
    latency.observe([result("c1")], T0 + 3_000);
    latency.observe([result("unknown")], T0 + 3_100);
    expect(spans).toEqual([
      {
        name: "run.tool_call",
        startMs: T0 + 1_000,
        endMs: T0 + 1_200,
        attributes: { "kobe.run.kind": "run", "kobe.tool.name": "read", "kobe.tool.error": true },
      },
      {
        name: "run.tool_call",
        startMs: T0 + 1_000,
        endMs: T0 + 3_000,
        attributes: { "kobe.run.kind": "run", "kobe.tool.name": "bash", "kobe.tool.error": false },
      },
    ]);
  });

  it("bounds the open tool calls it remembers", () => {
    const { spans, latency } = setup({ resumed: true, maxOpenTools: 1 });
    latency.observe([call("c1"), call("c2")], T0);
    latency.observe([result("c1"), result("c2")], T0 + 10);
    expect(spans).toHaveLength(1);
  });

  it("ignores malformed payloads", () => {
    const { spans, latency } = setup({ resumed: true });
    latency.observe(
      [
        { type: "tool.call", payload: null },
        { type: "tool.result", payload: 3 },
      ],
      T0,
    );
    expect(spans).toEqual([]);
  });
});

describe("toolNameAttribute", () => {
  it("keeps plain tool names and folds anything else into one bucket", () => {
    expect(toolNameAttribute("catalyst_2__lake-query")).toBe("catalyst_2__lake-query");
    expect(toolNameAttribute("x".repeat(65))).toBe("other");
    expect(toolNameAttribute("rm -rf /")).toBe("other");
    expect(toolNameAttribute(undefined)).toBe("other");
  });
});

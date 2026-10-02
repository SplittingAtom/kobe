import { describe, expect, it } from "vitest";
import {
  EVENT_PAYLOAD_SCHEMAS,
  KOBE_EVENT_TYPES,
  TERMINAL_EVENT_TYPES,
  formatSseEvent,
  isKobeEventType,
  isTerminalEventType,
  kobeEventSchema,
  parseEventPayload,
  resolveResumeCursor,
  type KobeEvent,
} from "./index.js";
import { EVENT_PAYLOAD_EXAMPLES, createInMemoryEventLog } from "./testing/index.js";

describe("Kobe Event Stream types", () => {
  it("lists every event type from the spec (§6.2)", () => {
    expect(KOBE_EVENT_TYPES).toEqual([
      "run.queued",
      "run.started",
      "sandbox.waking",
      "text.delta",
      "reasoning.delta",
      "tool.call",
      "tool.result",
      "approval.requested",
      "approval.resolved",
      "policy.denied",
      "egress.blocked",
      "steer.applied",
      "memory.updated",
      "artifact.created",
      "artifact.updated",
      "file.shared",
      "entry.committed",
      "run.completed",
      "run.failed",
      "run.interrupted",
      "run.budget_stopped",
    ]);
  });

  it("recognises known types and rejects unknown ones", () => {
    expect(isKobeEventType("text.delta")).toBe(true);
    expect(isKobeEventType("text.deltas")).toBe(false);
    expect(isKobeEventType(42)).toBe(false);
  });

  it("has exactly one payload schema per type", () => {
    expect(Object.keys(EVENT_PAYLOAD_SCHEMAS).sort()).toEqual([...KOBE_EVENT_TYPES].sort());
  });

  it("only run.* end states are terminal", () => {
    expect(TERMINAL_EVENT_TYPES).toEqual([
      "run.completed",
      "run.failed",
      "run.interrupted",
      "run.budget_stopped",
    ]);
    expect(isTerminalEventType("run.started")).toBe(false);
  });
});

describe("event payloads", () => {
  it.each(KOBE_EVENT_TYPES)("accepts the example payload for %s", (type) => {
    expect(parseEventPayload(type, EVENT_PAYLOAD_EXAMPLES[type])).toEqual(
      EVENT_PAYLOAD_EXAMPLES[type],
    );
  });

  it.each(KOBE_EVENT_TYPES)("rejects unknown keys on %s", (type) => {
    expect(() =>
      parseEventPayload(type, { ...EVENT_PAYLOAD_EXAMPLES[type], surprise: 1 }),
    ).toThrow();
  });

  it.each([
    ["text.delta", { message_id: "m", content_index: -1, delta: "x" }],
    ["text.delta", { message_id: "", content_index: 0, delta: "x" }],
    ["tool.call", { tool_call_id: "tc", tool: "bash", input: {}, risk: "safe" }],
    ["approval.requested", { ...EVENT_PAYLOAD_EXAMPLES["approval.requested"], reasons: [] }],
    [
      "approval.requested",
      { ...EVENT_PAYLOAD_EXAMPLES["approval.requested"], expires_at: "tomorrow" },
    ],
    ["approval.resolved", { ...EVENT_PAYLOAD_EXAMPLES["approval.resolved"], decision: "allow" }],
    ["artifact.created", { ...EVENT_PAYLOAD_EXAMPLES["artifact.created"], kind: "tsx" }],
    ["artifact.updated", { artifact_id: "a", version: 1 }],
    ["run.interrupted", { reason: "crashed", last_entry_id: null, retryable: true }],
    ["run.queued", { thread_id: "t", trigger: "webhook", queue_pos: 1 }],
  ] as const)("rejects an invalid %s payload", (type, payload) => {
    expect(() => parseEventPayload(type, payload)).toThrow();
  });
});

describe("event envelope", () => {
  const event: KobeEvent<"text.delta"> = {
    run_id: "run_7f",
    seq: 1042,
    ts: "2026-10-01T22:00:00.123Z",
    type: "text.delta",
    payload: EVENT_PAYLOAD_EXAMPLES["text.delta"],
  };

  it("parses a valid envelope and discriminates on type", () => {
    expect(kobeEventSchema.parse(event)).toEqual(event);
  });

  it.each([
    ["seq 0", { ...event, seq: 0 }],
    ["fractional seq", { ...event, seq: 1.5 }],
    ["non-UTC ts", { ...event, ts: "2026-10-01T22:00:00+02:00" }],
    ["unknown type", { ...event, type: "text.deltas" }],
    ["payload of another type", { ...event, payload: EVENT_PAYLOAD_EXAMPLES["run.failed"] }],
    ["extra envelope key", { ...event, team_id: "t" }],
  ])("rejects %s", (_label, value) => {
    expect(kobeEventSchema.safeParse(value).success).toBe(false);
  });

  it("frames SSE with id = seq, event = type, single-line data = envelope", () => {
    const withNewline = { ...event, payload: { ...event.payload, delta: "a\nb\u2028c" } };
    const frame = formatSseEvent(withNewline);
    expect(frame.startsWith("id: 1042\nevent: text.delta\ndata: {")).toBe(true);
    expect(frame.endsWith("}\n\n")).toBe(true);
    expect(frame.split("\n")).toHaveLength(5);
    expect(JSON.parse((frame.split("\n")[2] ?? "").slice("data: ".length))).toEqual(withNewline);
  });
});

describe("resume cursor", () => {
  it.each([
    [{}, 0],
    [{ lastEventId: "41" }, 41],
    [{ startingAfter: "7", lastEventId: "41" }, 7],
    [{ startingAfter: "", lastEventId: "41" }, 41],
    [{ startingAfter: null, lastEventId: null }, 0],
    [{ startingAfter: "0" }, 0],
  ])("resolves %j to %d", (input, after) => {
    expect(resolveResumeCursor(input)).toEqual({ ok: true, after });
  });

  it.each(["-1", "01", "1.5", "abc", " 3", "99999999999999999"])("rejects %j", (raw) => {
    expect(resolveResumeCursor({ startingAfter: raw })).toEqual({
      ok: false,
      error: "invalid_cursor",
    });
  });
});

describe("in-memory event log fake", () => {
  it("assigns per-run gapless seq and replays after a cursor", () => {
    const log = createInMemoryEventLog(() => new Date("2026-10-01T22:00:00Z"));
    log.append("r1", "run.started", EVENT_PAYLOAD_EXAMPLES["run.started"]);
    log.append("r2", "run.started", EVENT_PAYLOAD_EXAMPLES["run.started"]);
    log.append("r1", "text.delta", EVENT_PAYLOAD_EXAMPLES["text.delta"]);
    expect(log.readAfter("r1", 0).map((e) => e.seq)).toEqual([1, 2]);
    expect(log.readAfter("r1", 1).map((e) => e.type)).toEqual(["text.delta"]);
    expect(log.readAfter("r2", 0)).toHaveLength(1);
  });

  it("validates payloads and notifies subscribers", () => {
    const log = createInMemoryEventLog();
    const seen: number[] = [];
    const off = log.subscribe("r", (e) => seen.push(e.seq));
    log.append("r", "sandbox.waking", { reason: "hibernated" });
    off();
    log.append("r", "sandbox.waking", { reason: "first_start" });
    expect(seen).toEqual([1]);
    expect(() => log.append("r", "sandbox.waking", { reason: "nope" } as never)).toThrow();
  });
});

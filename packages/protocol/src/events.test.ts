import { describe, expect, it } from "vitest";
import {
  EVENT_ENTRY_PAYLOAD_MAX_BYTES,
  EVENT_PAYLOAD_MAX_BYTES,
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TOOL_INPUT_MAX_BYTES,
  EventPayloadTooLargeError,
  jsonByteLength,
  KOBE_EVENT_TYPES,
  TERMINAL_EVENT_TYPES,
  formatSseEvent,
  isKobeEventType,
  isTerminalEventType,
  kobeEventSchema,
  parseEventPayload,
  decideStreamOpen,
  resolveResumeCursor,
  type KobeEvent,
} from "./index.js";
import { EVENT_PAYLOAD_EXAMPLES, EXAMPLE_IDS, createInMemoryEventLog } from "./testing/index.js";

describe("Kobe Event Stream types", () => {
  it("lists every event type from the spec (§6.2)", () => {
    expect(KOBE_EVENT_TYPES).toEqual([
      "run.queued",
      "run.started",
      "sandbox.waking",
      "context.omitted",
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

describe("context.omitted", () => {
  const schema = EVENT_PAYLOAD_SCHEMAS["context.omitted"];
  const item = { kind: "connector", name: "github", reason: "not_user_connected" };

  it("accepts one or more omitted items and every reason", () => {
    expect(schema.safeParse({ items: [item] }).success).toBe(true);
    for (const reason of [
      "agent_exclusive",
      "team_disabled",
      "blocklisted",
      "shadowed_by_agent",
      "not_team_enabled",
      "not_user_connected",
      "no_team_default",
    ]) {
      expect(schema.safeParse({ items: [{ ...item, reason }] }).success).toBe(true);
    }
  });

  it("rejects an empty list, unknown kinds and reasons, and extra keys", () => {
    expect(schema.safeParse({ items: [] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ ...item, kind: "tool" }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ ...item, reason: "other" }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ ...item, extra: 1 }] }).success).toBe(false);
  });

  it("is not terminal", () => {
    expect(isTerminalEventType("context.omitted")).toBe(false);
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

describe("payload size bounds", () => {
  const big = (bytes: number) => "x".repeat(bytes);

  it("bounds tool.call input at 64 KiB, as the server summarises larger inputs", () => {
    const example = EVENT_PAYLOAD_EXAMPLES["tool.call"];
    expect(() =>
      parseEventPayload("tool.call", {
        ...example,
        input: { content: big(EVENT_TOOL_INPUT_MAX_BYTES) },
      }),
    ).toThrow();
    expect(
      parseEventPayload("tool.call", { ...example, input: { content: big(60 * 1024) } }),
    ).toBeTruthy();
  });

  it("bounds entry.committed payload at 64 KiB (larger entries are stored, not streamed)", () => {
    const example = EVENT_PAYLOAD_EXAMPLES["entry.committed"];
    expect(() =>
      parseEventPayload("entry.committed", {
        ...example,
        payload: { t: big(EVENT_ENTRY_PAYLOAD_MAX_BYTES) },
      }),
    ).toThrow();
  });

  it("bounds every payload at 256 KiB as UTF-8 JSON", () => {
    expect(EVENT_PAYLOAD_MAX_BYTES).toBe(256 * 1024);
    const delta = { ...EVENT_PAYLOAD_EXAMPLES["text.delta"], delta: "é".repeat(130 * 1024) };
    expect(jsonByteLength(delta)).toBeGreaterThan(EVENT_PAYLOAD_MAX_BYTES);
    expect(() => parseEventPayload("text.delta", delta)).toThrow(EventPayloadTooLargeError);
  });
});

describe("event envelope", () => {
  const event: KobeEvent<"text.delta"> = {
    run_id: EXAMPLE_IDS.run,
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
    [{ startingAfter: "7", lastEventId: "41" }, 41],
    [{ startingAfter: "41", lastEventId: "7" }, 41],
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

describe("stream open decision", () => {
  it.each([
    [{ ended: false, events_compacted: false, last_seq: 5, cursor: 9 }, "stream"],
    [{ ended: true, events_compacted: false, last_seq: 5, cursor: 3 }, "stream"],
    [{ ended: true, events_compacted: false, last_seq: 5, cursor: 5 }, "no_content"],
    [{ ended: true, events_compacted: true, last_seq: 5, cursor: 0 }, "gone"],
  ])("%j → %s", (run, kind) => {
    expect(decideStreamOpen(run).kind).toBe(kind);
  });
});

describe("payload id and input rules", () => {
  it("allows the install default agent (null pin) on run.started", () => {
    const payload = {
      ...EVENT_PAYLOAD_EXAMPLES["run.started"],
      agent_id: null,
      agent_version: null,
    };
    expect(parseEventPayload("run.started", payload)).toEqual(payload);
  });

  it("says where run.started's model came from (KOBE-44), from a closed set", () => {
    const base = { ...EVENT_PAYLOAD_EXAMPLES["run.started"], model: "smart" };
    for (const model_source of ["agent", "thread", "default"]) {
      expect(parseEventPayload("run.started", { ...base, model_source })).toMatchObject({
        model_source,
      });
    }
    expect(() => parseEventPayload("run.started", { ...base, model_source: "user" })).toThrow();
  });

  it("requires uuids for Kobe ids", () => {
    const payload = { ...EVENT_PAYLOAD_EXAMPLES["run.queued"], thread_id: "thr_1" };
    expect(() => parseEventPayload("run.queued", payload)).toThrow();
  });

  it("applies tool-input rules to tool.call and approval.requested", () => {
    for (const input of [{ n: 2 ** 53 }, { s: "a\u0000b" }, JSON.parse('{"__proto__":{"x":1}}')]) {
      expect(() =>
        parseEventPayload("tool.call", { ...EVENT_PAYLOAD_EXAMPLES["tool.call"], input }),
      ).toThrow();
      expect(() =>
        parseEventPayload("approval.requested", {
          ...EVENT_PAYLOAD_EXAMPLES["approval.requested"],
          input,
        }),
      ).toThrow();
    }
  });

  it("requires a cause on approval.resolved", () => {
    const { cause: _cause, ...rest } = EVENT_PAYLOAD_EXAMPLES["approval.resolved"];
    expect(() => parseEventPayload("approval.resolved", rest)).toThrow();
    expect(
      parseEventPayload("approval.resolved", {
        ...rest,
        decision: "expired",
        cause: "run_cancelled",
      }).cause,
    ).toBe("run_cancelled");
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

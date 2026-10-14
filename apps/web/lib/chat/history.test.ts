import { beforeEach, describe, expect, it } from "vitest";
import { parseEntry } from "./entries";
import {
  entryTime,
  formatDuration,
  inputSummary,
  offloadedResults,
  stepStart,
  timing,
  toolResultOf,
} from "./history";
import { assistant, resetEntrySeq, text, toolCall, toolResult, user } from "./testing/entries";
import type { ThreadEntry } from "./types";

beforeEach(() => resetEntrySeq());

const offloaded = (entryId: string, parentId: string, createdAt = "2026-10-02T10:00:09.000Z") =>
  ({
    entryId,
    parentId,
    seq: 99,
    type: "message",
    payload: {},
    payloadOffloaded: true,
    createdAt,
  }) satisfies ThreadEntry;

const parse = (entries: readonly ThreadEntry[]) =>
  new Map(entries.map((e) => [e.entryId, parseEntry(e)] as const));

describe("timing (KOBE-208)", () => {
  it("reads Pi's entry timestamp and the step's start; an offloaded entry uses createdAt", () => {
    const a = assistant("a1", "u1", text("hi"));
    const stamped: ThreadEntry = {
      ...a,
      payload: {
        ...a.payload,
        timestamp: "2026-10-02T10:00:05.000Z",
        message: { role: "assistant", content: [], timestamp: Date.parse("2026-10-02T10:00:01Z") },
      },
    };
    expect(entryTime(stamped)).toBe(Date.parse("2026-10-02T10:00:05Z"));
    expect(stepStart(stamped)).toBe(Date.parse("2026-10-02T10:00:01Z"));
    expect(entryTime(a)).toBeUndefined();
    expect(stepStart(a)).toBeUndefined();
    expect(entryTime(offloaded("o1", "a1"))).toBe(Date.parse("2026-10-02T10:00:09Z"));
  });

  it("is only known with both ends in order", () => {
    expect(timing(1_000, 3_000)).toEqual({ startedAt: 1_000, completedAt: 3_000 });
    expect(timing(undefined, 3_000)).toBeUndefined();
    expect(timing(1_000, undefined)).toBeUndefined();
    expect(timing(3_000, 1_000)).toBeUndefined();
  });

  it("formats durations", () => {
    expect(formatDuration(420)).toBe("0.4 s");
    expect(formatDuration(12_400)).toBe("12 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
    expect(formatDuration(120_000)).toBe("2 min");
  });
});

describe("offloadedResults", () => {
  it("gives each offloaded entry under a step the step's next unanswered call", () => {
    const entries = [
      user("u1", null, "go"),
      assistant("a1", "u1", toolCall("tc1", "bash"), toolCall("tc2", "read"), toolCall("tc3", "x")),
      toolResult("r1", "a1", "tc1", "small"),
      offloaded("o2", "r1"),
      offloaded("o3", "o2"),
      assistant("a2", "o3", text("done")),
      offloaded("o4", "a2"),
      offloaded("o5", "u1"),
    ];
    const answered = (id: string) => id === "tc1";
    expect([...offloadedResults(entries, parse(entries), answered)]).toEqual([
      ["tc2", "o2"],
      ["tc3", "o3"],
    ]);
  });
});

describe("inputSummary", () => {
  it("shows the main field in one line, else compact JSON, cut to the width", () => {
    expect(inputSummary({ command: "ls -la\n  /tmp", timeout: 5 })).toBe("ls -la /tmp");
    expect(inputSummary({ text: "only one" })).toBe("only one");
    expect(inputSummary({ a: 1, b: [2] })).toBe('{"a":1,"b":[2]}');
    expect(inputSummary({})).toBe("");
    expect(inputSummary({ query: "x".repeat(100) }, 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("toolResultOf", () => {
  it("reads a tool result from a body read back, and nothing else", () => {
    const body = toolResult("o1", "a1", "tc1", "big output", true).payload;
    expect(toolResultOf("o1", body)).toEqual({ text: "big output", isError: true });
    expect(toolResultOf("o1", user("u", null, "hi").payload)).toBeUndefined();
    expect(toolResultOf("o1", "nope")).toBeUndefined();
    expect(toolResultOf("o1", null)).toBeUndefined();
  });
});

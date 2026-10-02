import { decodeSandboxFrame, encodeFrame } from "@kobe/protocol";
import { EXAMPLE_IDS } from "@kobe/protocol/testing";
import { describe, expect, it } from "vitest";
import { TOO_DEEP_MARKER, parsePiRecord, sanitizeJson } from "./sanitize.js";

describe("sanitizeJson", () => {
  it("replaces U+0000 with U+FFFD in strings and keys", () => {
    expect(sanitizeJson({ "k\u0000": ["a\u0000b"] })).toEqual({ "k�": ["a�b"] });
  });

  it("drops __proto__ keys without touching prototypes", () => {
    const parsed = JSON.parse('{"__proto__":{"admin":true},"ok":1}') as unknown;
    const clean = sanitizeJson(parsed) as Record<string, unknown>;
    expect(Object.keys(clean)).toEqual(["ok"]);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it("caps nesting so the server's depth limit is never hit", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 300; i++) deep = [deep];
    const clean = sanitizeJson(deep);
    expect(JSON.stringify(clean)).toContain(TOO_DEEP_MARKER);
    const frame = {
      v: 1 as const,
      type: "pi.event" as const,
      run_id: EXAMPLE_IDS.run,
      thread_id: EXAMPLE_IDS.thread,
      seq: 1,
      event: { type: "x", deep: clean },
    };
    expect(decodeSandboxFrame(encodeFrame(frame)).ok).toBe(true);
  });

  it("turns non-finite numbers into null", () => {
    expect(sanitizeJson([Infinity, NaN, 1])).toEqual([null, null, 1]);
  });
});

describe("parsePiRecord", () => {
  it("parses JSON objects only", () => {
    expect(parsePiRecord('{"type":"agent_start"}')).toEqual({ type: "agent_start" });
    expect(parsePiRecord("[1]")).toBeUndefined();
    expect(parsePiRecord("nope")).toBeUndefined();
    expect(parsePiRecord("null")).toBeUndefined();
  });

  it("produces frames the server's strict decoder accepts", () => {
    const record = parsePiRecord('{"type":"x","a":"\\u0000","__proto__":{},"b":{"__proto__":1}}');
    const frame = {
      v: 1 as const,
      type: "pi.event" as const,
      run_id: EXAMPLE_IDS.run,
      thread_id: EXAMPLE_IDS.thread,
      seq: 1,
      event: record as { type: string },
    };
    expect(decodeSandboxFrame(encodeFrame(frame)).ok).toBe(true);
  });
});

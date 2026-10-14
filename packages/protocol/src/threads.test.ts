import { describe, expect, it } from "vitest";
import {
  CAPABILITY_THREAD_COMPACT,
  COMPACT_THREAD_ERROR_CODES,
  COMPACT_THREAD_ERROR_HTTP_STATUS,
  compactThreadErrorSchema,
  compactThreadRequestSchema,
  compactThreadResponseSchema,
  THREAD_COMPACT_FOCUS_MAX_CHARS,
  THREAD_COMPACT_SUMMARY_MAX_BYTES,
  threadCompactFocusSchema,
} from "./index.js";
import { EXAMPLE_IDS } from "./testing/index.js";

/** KOBE-212 (CE15): POST /v1/threads/{id}/compact. */
describe("compact thread request", () => {
  it("accepts no focus and a focus up to the limit", () => {
    expect(compactThreadRequestSchema.parse({})).toEqual({});
    const focus = "x".repeat(THREAD_COMPACT_FOCUS_MAX_CHARS);
    expect(compactThreadRequestSchema.parse({ focus })).toEqual({ focus });
    expect(compactThreadRequestSchema.parse({ focus: "Keep the SQL\nand the plan" })).toEqual({
      focus: "Keep the SQL\nand the plan",
    });
  });

  it("refuses an empty, blank, too long or control-character focus", () => {
    for (const focus of [
      "",
      "  \n\t ",
      "x".repeat(THREAD_COMPACT_FOCUS_MAX_CHARS + 1),
      "a\u0000b",
      "a\u001bb",
      "a\u007fb",
      42,
      null,
    ]) {
      expect(compactThreadRequestSchema.safeParse({ focus }).success, String(focus)).toBe(false);
    }
  });

  it("refuses unknown keys (strict)", () => {
    expect(compactThreadRequestSchema.safeParse({ focus: "a", model: "x" }).success).toBe(false);
  });

  it("keeps the focus as sent (no trimming on the contract)", () => {
    expect(threadCompactFocusSchema.parse(" the plan ")).toBe(" the plan ");
  });
});

describe("compact thread response", () => {
  const ok = {
    thread_id: EXAMPLE_IDS.thread,
    summary: "## Goal\nShip the report.",
    first_kept_entry_id: "c3d4e5f6",
    tokens_before: 150_000,
    estimated_tokens_after: 32_000,
  };

  it("accepts Pi's result shape, with optional summary and estimate", () => {
    expect(compactThreadResponseSchema.parse(ok)).toEqual(ok);
    const { summary: _s, estimated_tokens_after: _e, ...minimal } = ok;
    expect(compactThreadResponseSchema.parse(minimal)).toEqual(minimal);
  });

  it("refuses bad counts, ids and unknown keys", () => {
    for (const bad of [
      { ...ok, tokens_before: -1 },
      { ...ok, tokens_before: 1.5 },
      { ...ok, estimated_tokens_after: -3 },
      { ...ok, first_kept_entry_id: "" },
      { ...ok, thread_id: "not-a-uuid" },
      { ...ok, details: {} },
    ]) {
      expect(compactThreadResponseSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("caps the summary in UTF-8 bytes", () => {
    const max = "a".repeat(THREAD_COMPACT_SUMMARY_MAX_BYTES);
    expect(compactThreadResponseSchema.safeParse({ ...ok, summary: max }).success).toBe(true);
    const over = "é".repeat(THREAD_COMPACT_SUMMARY_MAX_BYTES / 2) + "a";
    expect(compactThreadResponseSchema.safeParse({ ...ok, summary: over }).success).toBe(false);
  });
});

describe("compact thread errors", () => {
  it("names the codes and their HTTP status", () => {
    expect(COMPACT_THREAD_ERROR_CODES).toEqual([
      "thread_busy",
      "sandbox_unavailable",
      "nothing_to_compact",
      "compaction_failed",
    ]);
    expect(COMPACT_THREAD_ERROR_HTTP_STATUS).toEqual({
      thread_busy: 409,
      sandbox_unavailable: 503,
      nothing_to_compact: 409,
      compaction_failed: 502,
    });
  });

  it("validates the error body", () => {
    expect(
      compactThreadErrorSchema.parse({ code: "thread_busy", message: "a run is active" }),
    ).toEqual({ code: "thread_busy", message: "a run is active" });
    expect(compactThreadErrorSchema.safeParse({ code: "busy", message: "x" }).success).toBe(false);
    expect(
      compactThreadErrorSchema.safeParse({ code: "thread_busy", message: "x".repeat(2001) })
        .success,
    ).toBe(false);
  });

  it("gates the wire command on a hello capability", () => {
    expect(CAPABILITY_THREAD_COMPACT).toBe("thread_compact");
  });
});

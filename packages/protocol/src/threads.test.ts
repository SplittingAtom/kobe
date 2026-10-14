import { describe, expect, it } from "vitest";
import {
  CAPABILITY_THREAD_COMPACT,
  COMPACT_THREAD_ERROR_CODES,
  COMPACT_THREAD_ERROR_HTTP_STATUS,
  COMPACT_THREAD_ERROR_MESSAGES,
  compactThreadError,
  compactThreadErrorSchema,
  compactThreadRequestSchema,
  compactThreadResponseSchema,
  THREAD_COMPACT_FOCUS_MAX_CHARS,
  THREAD_COMPACT_SUMMARY_MAX_BYTES,
  threadCompactFocusSchema,
  threadOrganizationSchema,
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
      "a\u2028b",
      "a\u202eb",
      "a\u2066b",
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
      { ...ok, first_kept_entry_id: "a\nb" },
      { ...ok, first_kept_entry_id: "x".repeat(129) },
      { ...ok, summary: "" },
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
      "model_not_configured",
      "compaction_failed",
    ]);
    expect(COMPACT_THREAD_ERROR_HTTP_STATUS).toEqual({
      thread_busy: 409,
      sandbox_unavailable: 503,
      nothing_to_compact: 409,
      model_not_configured: 409,
      compaction_failed: 502,
    });
  });

  it("answers each code with its fixed message", () => {
    for (const code of COMPACT_THREAD_ERROR_CODES) {
      const body = compactThreadError(code);
      expect(body).toEqual({ code, message: COMPACT_THREAD_ERROR_MESSAGES[code] });
      expect(compactThreadErrorSchema.parse(body)).toEqual(body);
    }
  });

  it("refuses any other message (never Pi's or the sandbox's text), unknown codes and keys", () => {
    for (const bad of [
      { code: "compaction_failed", message: "Compaction failed: 401 from http://gateway/v1" },
      { code: "thread_busy", message: COMPACT_THREAD_ERROR_MESSAGES.compaction_failed },
      { code: "busy", message: COMPACT_THREAD_ERROR_MESSAGES.thread_busy },
      { ...compactThreadError("thread_busy"), detail: "x" },
      { code: "thread_busy" },
    ]) {
      expect(compactThreadErrorSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("gates the wire command on a hello capability", () => {
    expect(CAPABILITY_THREAD_COMPACT).toBe("thread_compact");
  });
});

/** KOBE-215 (CE16, CE18, CE19): pin, archive, title lock and fork provenance on a thread summary. */
describe("thread organization fields", () => {
  const full = {
    pinned_at: "2026-10-14T08:00:00Z",
    archived_at: "2026-10-14T09:30:00.123Z",
    title_locked: true,
    forked_from_thread_id: EXAMPLE_IDS.thread,
    forked_at_entry_id: "c3d4e5f6",
  };

  it("decodes absent fields as not pinned, not archived, unlocked, not a fork (additive)", () => {
    expect(threadOrganizationSchema.parse({})).toEqual({
      pinned_at: null,
      archived_at: null,
      title_locked: false,
      forked_from_thread_id: null,
      forked_at_entry_id: null,
    });
  });

  it("accepts every field set, and nulls", () => {
    expect(threadOrganizationSchema.parse(full)).toEqual(full);
    const nulls = {
      pinned_at: null,
      archived_at: null,
      title_locked: false,
      forked_from_thread_id: null,
      forked_at_entry_id: null,
    };
    expect(threadOrganizationSchema.parse(nulls)).toEqual(nulls);
  });

  it("keeps a fork point whose source thread is gone (purged source)", () => {
    const orphan = { ...full, forked_from_thread_id: null };
    expect(threadOrganizationSchema.parse(orphan)).toEqual(orphan);
  });

  it("refuses malformed values", () => {
    for (const bad of [
      { ...full, pinned_at: "yesterday" },
      { ...full, archived_at: "2026-10-14T08:00:00+02:00" },
      { ...full, title_locked: null },
      { ...full, title_locked: "true" },
      { ...full, forked_from_thread_id: "not-a-uuid" },
      { ...full, forked_from_thread_id: EXAMPLE_IDS.thread.toUpperCase() },
      { ...full, forked_at_entry_id: "" },
      { ...full, forked_at_entry_id: "x".repeat(129) },
      { ...full, forked_at_entry_id: "a\nb" },
    ]) {
      expect(threadOrganizationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

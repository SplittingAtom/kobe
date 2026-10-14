import { describe, expect, it } from "vitest";
import {
  SANDBOX_FRAME_MAX_BYTES_BY_TYPE,
  SANDBOX_SMALL_FRAME_MAX_BYTES,
  THREAD_COMPACT_FOCUS_MAX_CHARS,
  THREAD_COMPACT_SUMMARY_MAX_BYTES,
  THREAD_COMPACT_WIRE_ERROR_CODES,
  decodeSandboxFrame,
  decodeServerFrame,
  encodeFrame,
  piBridgeCommandSchema,
  threadCompactFrameSchema,
  threadCompactResultFrameSchema,
} from "../index.js";
import { EXAMPLE_IDS } from "../testing/index.js";

const THREAD = EXAMPLE_IDS.thread;
const RUN = EXAMPLE_IDS.run;

const compact = {
  v: 1,
  type: "thread.compact",
  command_id: "c1",
  thread_id: THREAD,
  run_id: RUN,
  model: { alias: "fast", gateway_model: "ollama/qwen3", api: "openai-completions" },
  run_token: { token: "krt1.abc", expires_at: "2026-10-14T12:00:00Z" },
};
const result = {
  v: 1,
  type: "thread.compact_result",
  command_id: "c1",
  thread_id: THREAD,
  ok: true,
  summary: "## Goal\nShip it.",
  first_kept_entry_id: "c3d4e5f6",
  tokens_before: 150_000,
  estimated_tokens_after: 32_000,
};

/** KOBE-212 (CE15): server → sandbox `thread.compact` and its `thread.compact_result`. */
describe("thread.compact (server → sandbox)", () => {
  it("decodes with the compaction run's context, with or without focus and limits", () => {
    expect(decodeServerFrame(JSON.stringify(compact))).toEqual({ ok: true, frame: compact });
    const full = {
      ...compact,
      focus: "Keep the schema decisions",
      model_limits: { max_output_tokens: 8192, context_window: 131072 },
    };
    expect(decodeServerFrame(JSON.stringify(full))).toEqual({ ok: true, frame: full });
  });

  it("requires the run, a resolved model and the run token (no run-less path)", () => {
    for (const key of ["run_id", "model", "run_token"] as const) {
      const { [key]: _dropped, ...rest } = compact;
      expect(threadCompactFrameSchema.safeParse(rest).success, key).toBe(false);
    }
    for (const model of [
      { alias: "fast" },
      { alias: "fast", gateway_model: "ollama/qwen3" },
      { alias: "fast", api: "openai-completions" },
      { ...compact.model, extra: 1 },
    ]) {
      expect(threadCompactFrameSchema.safeParse({ ...compact, model }).success).toBe(false);
    }
    expect(threadCompactFrameSchema.safeParse({ ...compact, run_id: "nope" }).success).toBe(false);
  });

  it("refuses a bad focus, a bad thread id and unknown keys", () => {
    for (const bad of [
      { ...compact, focus: "" },
      { ...compact, focus: " " },
      { ...compact, focus: "x".repeat(THREAD_COMPACT_FOCUS_MAX_CHARS + 1) },
      { ...compact, thread_id: "nope" },
      { ...compact, customInstructions: "x" },
      { ...compact, command_id: "" },
    ]) {
      expect(threadCompactFrameSchema.safeParse(bad).success).toBe(false);
      expect(decodeServerFrame(JSON.stringify(bad)).ok).toBe(false);
    }
  });
});

describe("pi.command cannot compact (KOBE-212)", () => {
  it("refuses compact through the raw Pi bridge, with or without instructions", () => {
    for (const command of [
      { id: "c1", type: "compact" },
      { id: "c1", type: "compact", customInstructions: "keep the plan" },
    ]) {
      const frame = { v: 1, type: "pi.command", command_id: "c1", thread_id: THREAD, command };
      expect(decodeServerFrame(JSON.stringify(frame)).ok).toBe(false);
      expect(piBridgeCommandSchema.safeParse(command).success).toBe(false);
    }
  });
});

describe("thread.compact_result (sandbox → server)", () => {
  it("decodes success with and without the optional fields", () => {
    expect(decodeSandboxFrame(encodeFrame(result as never))).toEqual({ ok: true, frame: result });
    const { summary: _s, estimated_tokens_after: _e, ...minimal } = result;
    expect(decodeSandboxFrame(JSON.stringify(minimal))).toEqual({ ok: true, frame: minimal });
  });

  it("decodes failure with a known code only (sandbox → server stays strict)", () => {
    for (const code of THREAD_COMPACT_WIRE_ERROR_CODES) {
      const failed = {
        v: 1,
        type: "thread.compact_result",
        command_id: "c1",
        thread_id: THREAD,
        ok: false,
        error: { code, message: "Nothing to compact (session too small)" },
      };
      expect(decodeSandboxFrame(JSON.stringify(failed))).toEqual({ ok: true, frame: failed });
    }
    const unknown = {
      v: 1,
      type: "thread.compact_result",
      command_id: "c1",
      thread_id: THREAD,
      ok: false,
      error: { code: "weird", message: "x" },
    };
    expect(decodeSandboxFrame(JSON.stringify(unknown)).ok).toBe(false);
  });

  it("names the wire error codes", () => {
    expect(THREAD_COMPACT_WIRE_ERROR_CODES).toEqual([
      "thread_busy",
      "nothing_to_compact",
      "compaction_failed",
      "model_not_configured",
      "pi_unavailable",
      "internal",
      "runtime_tampered",
    ]);
  });

  it("refuses mixed shapes, Pi's camelCase keys and bad counts", () => {
    for (const bad of [
      { ...result, error: { code: "internal", message: "x" } },
      { ...result, firstKeptEntryId: "x" },
      { ...result, details: { readFiles: [] } },
      { ...result, tokens_before: -1 },
      { ...result, first_kept_entry_id: "" },
      { ...result, first_kept_entry_id: "a\u0000b" },
      { ...result, summary: "" },
      { ...result, command_id: "" },
      { ...result, thread_id: "nope" },
    ]) {
      expect(threadCompactResultFrameSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("caps the summary in UTF-8 bytes and has its own frame size entry", () => {
    const at = { ...result, summary: "a".repeat(THREAD_COMPACT_SUMMARY_MAX_BYTES) };
    expect(threadCompactResultFrameSchema.safeParse(at).success).toBe(true);
    const over = { ...result, summary: "é".repeat(THREAD_COMPACT_SUMMARY_MAX_BYTES / 2 + 1) };
    expect(threadCompactResultFrameSchema.safeParse(over).success).toBe(false);
    const cap = SANDBOX_FRAME_MAX_BYTES_BY_TYPE["thread.compact_result"];
    expect(cap).toBe(1024 * 1024);
    expect(cap).toBeGreaterThan(SANDBOX_SMALL_FRAME_MAX_BYTES);
    expect(cap).toBeGreaterThan(THREAD_COMPACT_SUMMARY_MAX_BYTES * 2);
  });
});

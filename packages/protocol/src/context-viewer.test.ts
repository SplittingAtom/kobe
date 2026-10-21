import { describe, expect, it } from "vitest";
import {
  CONTEXT_SECTION_KINDS,
  CONTEXT_SECTION_MAX_CHARS,
  THREAD_CONTEXT_ERROR_CODES,
  THREAD_CONTEXT_ERROR_HTTP_STATUS,
  contextSectionSchema,
  threadContextError,
  threadContextResultSchema,
  threadContextSchema,
  threadContextWakingSchema,
} from "./context-viewer.js";
import { serverToSandboxFrameSchema } from "./sandbox-wire/frames.js";
import {
  THREAD_CONTEXT_MAX_BYTES,
  threadContextFrameSchema,
} from "./sandbox-wire/context-frames.js";

const THREAD = "6f1c3f0e-5a8e-4a49-9d0e-1f2a3b4c5d6e";

const section = (over: Record<string, unknown> = {}) => ({
  kind: "user_message",
  label: "User",
  text: "Hello",
  tokens: 2,
  chars: 5,
  truncated: false,
  ...over,
});

const result = (over: Record<string, unknown> = {}) => ({
  source: "model_call",
  exact: true,
  missing: [],
  captured_at: "2026-10-21T10:00:00.000Z",
  model: "glm-5",
  context_window: 200_000,
  total_tokens: 2,
  tokens_basis: "usage",
  sections: [section()],
  truncated: false,
  omitted_sections: 0,
  ...over,
});

describe("context viewer shapes (KOBE-470)", () => {
  it("lists the section kinds the spec names, in order", () => {
    expect(CONTEXT_SECTION_KINDS).toEqual([
      "system_prompt",
      "agent_instructions",
      "skills",
      "memory",
      "viewing_file",
      "tool_definitions",
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_result",
      "compaction_summary",
      "other",
    ]);
  });

  it("takes a section and refuses unknown kinds, negative tokens and oversized text", () => {
    expect(contextSectionSchema.safeParse(section()).success).toBe(true);
    expect(contextSectionSchema.safeParse(section({ kind: "secret" })).success).toBe(false);
    expect(contextSectionSchema.safeParse(section({ tokens: -1 })).success).toBe(false);
    expect(contextSectionSchema.safeParse(section({ extra: 1 })).success).toBe(false);
    const long = "x".repeat(CONTEXT_SECTION_MAX_CHARS + 200);
    expect(contextSectionSchema.safeParse(section({ text: long })).success).toBe(false);
  });

  it("takes the sandbox's result and the route's answer, which adds the thread", () => {
    expect(threadContextResultSchema.safeParse(result()).success).toBe(true);
    expect(threadContextResultSchema.safeParse(result({ source: "guess" })).success).toBe(false);
    expect(
      threadContextResultSchema.safeParse(
        result({ source: "none", captured_at: null, model: null, context_window: null }),
      ).success,
    ).toBe(true);
    expect(threadContextSchema.safeParse({ ...result(), thread_id: THREAD }).success).toBe(true);
    expect(threadContextSchema.safeParse(result()).success).toBe(false);
  });

  it("answers waking with a retry delay", () => {
    expect(
      threadContextWakingSchema.safeParse({ status: "waking", retry_after_ms: 2000 }).success,
    ).toBe(true);
  });

  it("has one fixed message and status per error code", () => {
    for (const code of THREAD_CONTEXT_ERROR_CODES) {
      expect(threadContextError(code).code).toBe(code);
      expect(THREAD_CONTEXT_ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
    expect(THREAD_CONTEXT_ERROR_HTTP_STATUS.not_owner).toBe(403);
  });

  it("is a server-to-sandbox command with a bounded size", () => {
    const frame = {
      v: 1,
      type: "thread.context",
      command_id: "c1",
      thread_id: THREAD,
      max_bytes: THREAD_CONTEXT_MAX_BYTES,
      reply_key: { alg: "x25519-hkdf-sha256-aes256gcm", public_key: "A".repeat(43) },
    };
    expect(threadContextFrameSchema.safeParse(frame).success).toBe(true);
    expect(serverToSandboxFrameSchema.safeParse(frame).success).toBe(true);
    expect(
      threadContextFrameSchema.safeParse({ ...frame, max_bytes: THREAD_CONTEXT_MAX_BYTES + 1 })
        .success,
    ).toBe(false);
    const { reply_key: _key, ...unsealed } = frame;
    expect(threadContextFrameSchema.safeParse(unsealed).success).toBe(false);
  });
});

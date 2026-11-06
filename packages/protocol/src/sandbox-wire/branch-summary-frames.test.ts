import { describe, expect, it } from "vitest";
import {
  BRANCH_SUMMARY_FOCUS_MAX_CHARS,
  THREAD_BRANCH_SUMMARY_WIRE_ERROR_CODES,
  branchSummaryResponseSchema,
  sandboxToServerFrameSchema,
  serverToSandboxFrameSchema,
  threadBranchSummaryFrameSchema,
  threadBranchSummaryResultFrameSchema,
} from "../index.js";
import { EXAMPLE_IDS } from "../testing/index.js";

const summary = {
  v: 1,
  type: "thread.branch_summary",
  command_id: "c1",
  thread_id: EXAMPLE_IDS.thread,
  run_id: EXAMPLE_IDS.run,
  from_leaf_entry_id: "a1b2c3d4",
  to_entry_id: "e5f6a7b8",
  model: { alias: "fast", gateway_model: "ollama/qwen3", api: "openai-completions" },
  run_token: { token: "krt1.abc", expires_at: "2026-10-14T12:00:00Z" },
};

/** KOBE-542 (CT11, CT20): server → sandbox `thread.branch_summary`, shaped like `thread.compact`. */
describe("thread.branch_summary (server → sandbox)", () => {
  it("parses with the run's context, with or without focus, limits and trace", () => {
    expect(threadBranchSummaryFrameSchema.parse(summary)).toEqual(summary);
    const full = {
      ...summary,
      focus: "Keep the pricing numbers",
      model_limits: { max_output_tokens: 8192, context_window: 131072 },
    };
    expect(threadBranchSummaryFrameSchema.parse(full)).toEqual(full);
  });

  it("requires both entries, the run, a resolved model and the run token", () => {
    for (const key of [
      "from_leaf_entry_id",
      "to_entry_id",
      "run_id",
      "model",
      "run_token",
      "command_id",
      "thread_id",
    ] as const) {
      const { [key]: _dropped, ...rest } = summary;
      expect(threadBranchSummaryFrameSchema.safeParse(rest).success, key).toBe(false);
    }
  });

  it("refuses a bad focus, empty entries and unknown keys", () => {
    for (const bad of [
      { ...summary, focus: "" },
      { ...summary, focus: "two\nlines" },
      { ...summary, focus: "x".repeat(BRANCH_SUMMARY_FOCUS_MAX_CHARS + 1) },
      { ...summary, to_entry_id: "" },
      { ...summary, from_leaf_entry_id: "" },
      { ...summary, thread_id: "nope" },
      { ...summary, entries: [] },
      { ...summary, model: { alias: "fast" } },
    ]) {
      expect(threadBranchSummaryFrameSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("is a frame the server sends (KOBE-548)", () => {
    expect(serverToSandboxFrameSchema.parse(summary)).toEqual(summary);
  });
});

const ok = {
  v: 1,
  type: "thread.branch_summary_result",
  command_id: "c1",
  thread_id: EXAMPLE_IDS.thread,
  ok: true,
  entry_id: "03bd22f9",
  parent_id: "57913d65",
};

/** KOBE-548: sandbox → server `thread.branch_summary_result`. */
describe("thread.branch_summary_result (sandbox → server)", () => {
  it("parses the appended entry, alone and in the union", () => {
    expect(threadBranchSummaryResultFrameSchema.parse(ok)).toEqual(ok);
    expect(sandboxToServerFrameSchema.parse(ok)).toEqual(ok);
  });

  it("parses every wire error code", () => {
    for (const code of THREAD_BRANCH_SUMMARY_WIRE_ERROR_CODES) {
      const err = {
        v: 1,
        type: "thread.branch_summary_result",
        command_id: "c1",
        thread_id: EXAMPLE_IDS.thread,
        ok: false,
        error: { code, message: "x" },
      };
      expect(sandboxToServerFrameSchema.parse(err)).toEqual(err);
    }
  });

  it("refuses a missing entry, an unknown code and extra keys", () => {
    const { entry_id: _e, ...noEntry } = ok;
    const { parent_id: _p, ...noParent } = ok;
    for (const bad of [
      noEntry,
      noParent,
      { ...ok, summary: "text" },
      { ...ok, ok: false, error: { code: "nothing_to_compact", message: "x" } },
    ]) {
      expect(threadBranchSummaryResultFrameSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("POST /v1/threads/{id}/branch-summary response (KOBE-548)", () => {
  it("names the entry and the new leaf", () => {
    const body = { thread_id: EXAMPLE_IDS.thread, entry_id: "e1", leaf_entry_id: "e1" };
    expect(branchSummaryResponseSchema.parse(body)).toEqual(body);
    expect(branchSummaryResponseSchema.safeParse({ ...body, summary: "x" }).success).toBe(false);
  });
});

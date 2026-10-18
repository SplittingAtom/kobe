import { describe, expect, it } from "vitest";
import {
  EVAL_CASE_EXPECTED_MAX_CHARS,
  EVAL_CASE_MAX_ATTACHMENTS,
  EVAL_CASE_MAX_EARLIER_EXCHANGES,
  EVAL_CASE_MAX_TOOL_OUTPUTS,
  agentEvalCaseSummarySchema,
  evalCaseOptionsSchema,
  reviewEvalCaseBodySchema,
  shareEvalCaseBodySchema,
} from "./eval-cases.js";

const UUID = "0b7f6b2c-4a51-4f0e-9a43-5f1c7f3b9e21";
const DIGEST = "a".repeat(64);

describe("evalCaseOptionsSchema (KOBE-276)", () => {
  it("shares nothing extra by default", () => {
    expect(evalCaseOptionsSchema.parse({})).toEqual({
      earlier_exchanges: 0,
      tool_output_ids: [],
      attachment_ids: [],
    });
  });

  it.each([
    ["too many earlier exchanges", { earlier_exchanges: EVAL_CASE_MAX_EARLIER_EXCHANGES + 1 }],
    ["a negative count", { earlier_exchanges: -1 }],
    ["a repeated tool output", { tool_output_ids: ["t1", "t1"] }],
    [
      "too many tool outputs",
      {
        tool_output_ids: Array.from({ length: EVAL_CASE_MAX_TOOL_OUTPUTS + 1 }, (_, i) => `t${i}`),
      },
    ],
    [
      "too many attachments",
      { attachment_ids: Array.from({ length: EVAL_CASE_MAX_ATTACHMENTS + 1 }, () => UUID) },
    ],
    ["an attachment that is not a uuid", { attachment_ids: ["x"] }],
    ["an unknown field", { include_everything: true }],
  ])("refuses %s", (_, body) => {
    expect(evalCaseOptionsSchema.safeParse(body).success).toBe(false);
  });
});

describe("shareEvalCaseBodySchema", () => {
  it("needs the preview's digest", () => {
    expect(shareEvalCaseBodySchema.safeParse({}).success).toBe(false);
    expect(shareEvalCaseBodySchema.safeParse({ digest: "abc" }).success).toBe(false);
    expect(shareEvalCaseBodySchema.parse({ digest: DIGEST }).digest).toBe(DIGEST);
  });
});

describe("reviewEvalCaseBodySchema", () => {
  it("takes a status, an expected behaviour or both", () => {
    expect(reviewEvalCaseBodySchema.parse({ status: "dismissed" })).toEqual({
      status: "dismissed",
    });
    expect(
      reviewEvalCaseBodySchema.parse({ status: "accepted", expected_behaviour: "  Cite it. " }),
    ).toEqual({ status: "accepted", expected_behaviour: "Cite it." });
    expect(reviewEvalCaseBodySchema.parse({ expected_behaviour: null })).toEqual({
      expected_behaviour: null,
    });
  });

  it.each([
    ["an empty body", {}],
    ["an unknown status", { status: "done" }],
    ["a blank expected behaviour", { expected_behaviour: "  " }],
    ["a control character", { expected_behaviour: "a\u001bb" }],
    ["an over-long text", { expected_behaviour: "x".repeat(EVAL_CASE_EXPECTED_MAX_CHARS + 1) }],
  ])("refuses %s", (_, body) => {
    expect(reviewEvalCaseBodySchema.safeParse(body).success).toBe(false);
  });
});

describe("agentEvalCaseSummarySchema", () => {
  it("carries the day of sharing, never a time or a member", () => {
    const summary = {
      id: UUID,
      status: "open",
      agent_version: 2,
      reasons: ["wrong"],
      prompt_excerpt: "What is",
      shared_on: "2026-10-16",
      expected_behaviour: null,
      reviewed_at: null,
    };
    expect(agentEvalCaseSummarySchema.parse(summary)).toEqual(summary);
    expect(
      agentEvalCaseSummarySchema.safeParse({ ...summary, shared_on: "2026-10-16T10:00:00Z" })
        .success,
    ).toBe(false);
    expect(agentEvalCaseSummarySchema.safeParse({ ...summary, user_id: UUID }).success).toBe(false);
  });
});

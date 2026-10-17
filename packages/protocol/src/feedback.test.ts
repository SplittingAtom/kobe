import { describe, expect, it } from "vitest";
import {
  FEEDBACK_COMMENT_MAX_CHARS,
  agentFeedbackTotalsSchema,
  putFeedbackBodySchema,
} from "./feedback.js";

describe("putFeedbackBodySchema (KOBE-275)", () => {
  it("takes a bare thumbs up and fills the defaults", () => {
    expect(putFeedbackBodySchema.parse({ rating: "up" })).toEqual({
      rating: "up",
      reasons: [],
      comment: null,
      entry_id: null,
    });
  });

  it("takes a thumbs down with reasons and a trimmed comment", () => {
    const body = putFeedbackBodySchema.parse({
      rating: "down",
      reasons: ["wrong", "unsafe"],
      comment: "  Made up a figure.\nTwice. ",
      entry_id: "e1",
    });
    expect(body.comment).toBe("Made up a figure.\nTwice.");
    expect(body.reasons).toEqual(["wrong", "unsafe"]);
  });

  it.each([
    ["reasons on a thumbs up", { rating: "up", reasons: ["wrong"] }],
    ["a comment on a thumbs up", { rating: "up", comment: "nice" }],
    ["an unknown reason", { rating: "down", reasons: ["boring"] }],
    ["a repeated reason", { rating: "down", reasons: ["wrong", "wrong"] }],
    [
      "an over-long comment",
      { rating: "down", comment: "x".repeat(FEEDBACK_COMMENT_MAX_CHARS + 1) },
    ],
    ["a blank comment", { rating: "down", comment: "   " }],
    ["NUL in the comment", { rating: "down", comment: "a\u0000b" }],
    ["another control character", { rating: "down", comment: "a\u001bb" }],
    ["an unknown rating", { rating: "meh" }],
    ["an unknown field", { rating: "up", score: 5 }],
  ])("refuses %s", (_name, body) => {
    expect(putFeedbackBodySchema.safeParse(body).success).toBe(false);
  });
});

describe("agentFeedbackTotalsSchema", () => {
  it("has no field for text, threads or members", () => {
    const keys = JSON.stringify(agentFeedbackTotalsSchema.toJSONSchema());
    for (const word of ["comment", "thread", "user", "member", "entry"]) {
      expect(keys).not.toContain(word);
    }
  });
});

describe("threadFeedbackSchema", () => {
  it("lists answers with the caller's rating or null", async () => {
    const { threadFeedbackSchema } = await import("./feedback.js");
    const run = "0b6f0d4e-5a3c-4d8e-9a43-5f7b0f2d1c11";
    const thread = "1b6f0d4e-5a3c-4d8e-9a43-5f7b0f2d1c11";
    const parsed = threadFeedbackSchema.parse({
      thread_id: thread,
      answers: [
        { run_id: run, user_entry_id: "u1", feedback: null },
        {
          run_id: run,
          user_entry_id: null,
          feedback: {
            run_id: run,
            thread_id: thread,
            entry_id: null,
            rating: "up",
            reasons: [],
            comment: null,
            updated_at: "2026-10-16T10:00:00.000Z",
          },
        },
      ],
    });
    expect(parsed.answers).toHaveLength(2);
  });
});

describe("feedbackTotalsQuerySchema", () => {
  it("takes only the preset windows", async () => {
    const { feedbackTotalsQuerySchema } = await import("./feedback.js");
    expect(feedbackTotalsQuerySchema.parse({})).toEqual({});
    expect(feedbackTotalsQuerySchema.parse({ window: "90" })).toEqual({ window: 90 });
    for (const q of [{ window: "14" }, { from: "2026-10-01T00:00:00Z" }, { bucket: "day" }]) {
      expect(feedbackTotalsQuerySchema.safeParse(q).success, JSON.stringify(q)).toBe(false);
    }
  });
});

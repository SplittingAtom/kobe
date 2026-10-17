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

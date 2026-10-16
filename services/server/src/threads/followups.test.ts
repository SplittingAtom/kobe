import { describe, expect, it } from "vitest";
import {
  SERVER_CALL_MAX_BODY_BYTES,
  THREAD_SUGGESTION_MAX_CHARS,
  serverCallRequestSchema,
  threadSuggestionsSchema,
} from "@kobe/protocol";
import { followupMessages, parseFollowups } from "./followups.js";

describe("parseFollowups (KOBE-222 ac-5: threadSuggestionsSchema)", () => {
  it("takes three plain lines as they are", () => {
    expect(parseFollowups("Chart it by region\nWhat about Q4?\nCompare with last year")).toEqual([
      "Chart it by region",
      "What about Q4?",
      "Compare with last year",
    ]);
  });

  it.each([
    [
      "1. Chart it by region\n2) What about Q4?\n3: Compare",
      ["Chart it by region", "What about Q4?", "Compare"],
    ],
    ["- Chart it\n* Show Q4\n• Compare", ["Chart it", "Show Q4", "Compare"]],
    ['"Chart it"\n“Show Q4”\n**Compare**', ["Chart it", "Show Q4", "Compare"]],
    ["\n\n  Chart   it \r\n\r\nShow Q4\u2028Compare", ["Chart it", "Show Q4", "Compare"]],
  ])("cleans %j", (reply, expected) => {
    expect(parseFollowups(reply)).toEqual(expected);
  });

  it("keeps at most three, drops duplicates, links and over-long lines", () => {
    const long = "x".repeat(THREAD_SUGGESTION_MAX_CHARS + 1);
    const reply = [
      "Chart it",
      "chart it",
      "See https://example.com",
      "Read [this](x)",
      long,
      "Show Q4",
      "Compare",
      "A fourth",
    ].join("\n");
    expect(parseFollowups(reply)).toEqual(["Chart it", "Show Q4", "Compare"]);
  });

  it("removes controls and bidi overrides", () => {
    const [first] = parseFollowups("Chart\u202e it\u0007") ?? [];
    expect(first).toBe("Chart it");
  });

  it("is undefined when nothing usable is left", () => {
    expect(parseFollowups("")).toBeUndefined();
    expect(parseFollowups("\n - \n**\n")).toBeUndefined();
    expect(parseFollowups("https://a.example\nwww.b.example")).toBeUndefined();
  });

  it("always satisfies threadSuggestionsSchema", () => {
    const out = parseFollowups("a\nb\nc\nd\ne");
    expect(threadSuggestionsSchema.safeParse(out).success).toBe(true);
  });
});

describe("followupMessages", () => {
  it("quotes the last message and its answer under a system prompt", () => {
    const messages = followupMessages("What drives Q3?", "Renewals.");
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.content).toContain("What drives Q3?");
    expect(messages[1]?.content).toContain("Renewals.");
  });

  it("fits the server-call body even for huge messages", () => {
    const messages = followupMessages("q".repeat(100_000), "a".repeat(100_000));
    const body = serverCallRequestSchema.parse({
      model: "openai/gpt-fake",
      messages,
      max_tokens: 256,
      stream: false,
    });
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(SERVER_CALL_MAX_BODY_BYTES);
  });
});

import { describe, expect, it } from "vitest";
import { messageText, normaliseQuote, quotesOf } from "./items-export.js";

describe("quotesOf (KOBE-649)", () => {
  const t = "11111111-1111-4111-8111-111111111111";

  it("reads an array or { quotes } of { entry_id, quote }", () => {
    expect(quotesOf([{ entry_id: "e1", quote: "a" }], t)).toEqual([{ entryId: "e1", quote: "a" }]);
    expect(quotesOf({ quotes: [{ entry_id: "e2", quote: "b" }] }, t)).toEqual([
      { entryId: "e2", quote: "b" },
    ]);
  });

  it("drops quotes of another thread, malformed ones and evidence without a thread", () => {
    expect(
      quotesOf(
        [
          { entry_id: "e1", quote: "x", thread_id: "other" },
          { entry_id: 1, quote: "x" },
          { entry_id: "e1", quote: "  " },
          ["e1", "x"],
          null,
          "quote",
        ],
        t,
      ),
    ).toEqual([]);
    expect(quotesOf([{ entry_id: "e1", quote: "a" }], null)).toEqual([]);
    expect(quotesOf("a quote", t)).toEqual([]);
    expect(quotesOf({ other: [] }, t)).toEqual([]);
  });
});

describe("normaliseQuote and messageText (KOBE-649 M-1)", () => {
  it("compares across whitespace, case, typographic quotes and dashes", () => {
    expect(normaliseQuote("  “Close”\n the  BOOKS – now ")).toBe(
      normaliseQuote('"close" the books - now'),
    );
    expect(normaliseQuote("ﬁve")).toBe("five");
  });

  it("reads a string or the text parts of a Pi content list", () => {
    expect(messageText("hello")).toBe("hello");
    expect(
      messageText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]),
    ).toBe("a\n\nb");
    expect(messageText(null)).toBe("");
  });
});

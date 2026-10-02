import { describe, expect, it } from "vitest";
import {
  HIGHLIGHT_START as S,
  HIGHLIGHT_STOP as E,
  decodeCursor,
  encodeCursor,
  parseSnippet,
  searchThreadsInputSchema,
  splitQuery,
} from "./thread-search-format.js";

const id = "0b6f1c3e-6a54-4f4e-9d61-3f0b2d1c9a10";

const enc = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

describe("search cursor", () => {
  it.each(["9223372036854775807", "-9223372036854775808", "0"])(
    "accepts micros %s (bigint range)",
    (a) => {
      expect(decodeCursor(enc({ s: 0, a, i: id }))).toEqual({ score: 0, activityMicros: a, id });
    },
  );

  it("round-trips score, microseconds and id exactly", () => {
    const cursor = { score: 0.06079271038174629, activityMicros: "1790000000123456", id };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ["not base64 json", "%%%"],
    ["wrong shape", Buffer.from(JSON.stringify({ s: "1" })).toString("base64url")],
    [
      "extra keys",
      Buffer.from(JSON.stringify({ s: 1, a: "1", i: id, x: 1 })).toString("base64url"),
    ],
    ["bad id", Buffer.from(JSON.stringify({ s: 1, a: "1", i: "x" })).toString("base64url")],
    [
      "non-numeric micros",
      Buffer.from(JSON.stringify({ s: 1, a: "1; drop", i: id })).toString("base64url"),
    ],
    ["negative score", Buffer.from(JSON.stringify({ s: -1, a: "1", i: id })).toString("base64url")],
    ["micros above bigint", enc({ s: 1, a: "9223372036854775808", i: id })],
    ["micros below bigint", enc({ s: 1, a: "-9223372036854775809", i: id })],
    ["20-digit micros", enc({ s: 1, a: "99999999999999999999", i: id })],
  ])("rejects %s", (_label, encoded) => {
    expect(decodeCursor(encoded)).toBeNull();
  });
});

describe("parseSnippet", () => {
  it("splits highlighted and plain segments", () => {
    expect(parseSnippet(`the ${S}cat${E} sat on the ${S}mat${E}.`)).toEqual([
      { text: "the ", highlight: false },
      { text: "cat", highlight: true },
      { text: " sat on the ", highlight: false },
      { text: "mat", highlight: true },
      { text: ".", highlight: false },
    ]);
  });

  it("handles adjacent highlights, no highlights, and empty input", () => {
    expect(parseSnippet(`${S}a${E}${S}b${E}`)).toEqual([
      { text: "a", highlight: true },
      { text: "b", highlight: true },
    ]);
    expect(parseSnippet("<b>plain</b>")).toEqual([{ text: "<b>plain</b>", highlight: false }]);
    expect(parseSnippet("")).toEqual([]);
  });
});

describe("searchThreadsInputSchema", () => {
  it("trims the query and applies defaults", () => {
    expect(searchThreadsInputSchema.parse({ viewerUserId: id, query: "  hi  " })).toEqual({
      viewerUserId: id,
      query: "hi",
      projectIds: [],
      limit: 20,
      timeoutMs: 3000,
    });
  });

  it("rejects unknown keys", () => {
    expect(() =>
      searchThreadsInputSchema.parse({ viewerUserId: id, query: "x", teamId: id }),
    ).toThrow();
  });
});

describe("splitQuery (web-search syntax)", () => {
  it.each([
    ["qwerty -asdfgh", "qwerty", ["asdfgh"]],
    ['"zebra report" -"old draft" notes', "zebra report notes", ['"old draft"']],
    ["charts or graphs", "charts graphs", []],
    ["-alpha -beta", "", ["alpha", "beta"]],
    ['-"unterminated phrase', "", ['"unterminated phrase"']],
    ["e-mail - dash", "e-mail dash", []],
    ["  spaced   words ", "spaced words", []],
  ])("%s", (query, positive, excluded) => {
    expect(splitQuery(query)).toEqual({ positive, excluded });
  });
});

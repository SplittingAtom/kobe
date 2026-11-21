import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./thread-search-format.js";

/** KOBE-702: the search cursor moved to `makeCursorCodec`; a token from the old encoder. */
describe("search cursor wire format", () => {
  it("is byte-identical and old tokens still decode", () => {
    const cursor = {
      score: 0.5,
      activityMicros: "1759370000123456",
      id: "3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b",
    };
    const old =
      "eyJzIjowLjUsImEiOiIxNzU5MzcwMDAwMTIzNDU2IiwiaSI6IjNmMmI4YzFlLTRhNWQtNGU2Zi04YTliLTBjMWQyZTNmNGE1YiJ9";
    expect(encodeCursor(cursor)).toBe(old);
    expect(decodeCursor(old)).toEqual(cursor);
    expect(decodeCursor("e".repeat(5000))).toBeNull();
  });
});

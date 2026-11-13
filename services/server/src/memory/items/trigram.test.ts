import { describe, expect, it } from "vitest";
import { trigramSimilarity, trigrams } from "./trigram.js";

describe("trigrams (pg_trgm compatible)", () => {
  it("pads words like pg_trgm's show_trgm", () => {
    // SELECT show_trgm('Cat') → {"  c"," ca","at ",cat}
    const t = (s: string) =>
      s.charCodeAt(0) * 4294967296 + s.charCodeAt(1) * 65536 + s.charCodeAt(2);
    expect([...trigrams("Cat")].sort()).toEqual(["  c", " ca", "at ", "cat"].map(t).sort());
    expect(trigrams("a").size).toBe(2);
    expect(trigrams("a-b").size).toBe(4);
    expect(trigrams("!!").size).toBe(0);
  });

  it("matches similarity() values", () => {
    // SELECT similarity('word', 'two words') → 0.36363637
    expect(trigramSimilarity("word", trigrams("two words"))).toBeCloseTo(0.363636, 5);
    expect(trigramSimilarity("same text", trigrams("Same TEXT"))).toBe(1);
    expect(trigramSimilarity("", trigrams("x"))).toBe(0);
  });
});

it("agrees with pg_trgm on a sentence", () => {
  // SELECT similarity('Deploy freeze on Fridays', 'what about the deploy friday freeze?') → 0.46153846
  expect(
    trigramSimilarity("Deploy freeze on Fridays", trigrams("what about the deploy friday freeze?")),
  ).toBeCloseTo(0.461538, 5);
});

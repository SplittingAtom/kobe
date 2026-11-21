import { describe, expect, it } from "vitest";
import { canonicalJson } from "@kobe/protocol";
import { CanonicalInputError, parseCanonicalInput } from "./canonical-input.js";

describe("parseCanonicalInput", () => {
  it("parses the stored canonical text into the object it names", () => {
    const text = canonicalJson({ b: [1, { c: null }], a: "x" });
    expect(parseCanonicalInput({ id: "a1", inputCanonical: text })).toEqual({
      a: "x",
      b: [1, { c: null }],
    });
  });

  it("returns the parsed value untouched, so re-canonicalising gives the stored bytes", () => {
    const text = canonicalJson({
      path: "/workspace/a.txt",
      n: 1.5,
      deep: { z: [true], "10": "x" },
    });
    const input = parseCanonicalInput({ id: "a1", inputCanonical: text });
    expect(canonicalJson(input)).toBe(text);
  });

  it.each([
    ["not JSON", "{oops"],
    ["an array", "[1,2]"],
    ["a string", '"x"'],
    ["null", "null"],
  ])("throws one typed error for %s", (_label, text) => {
    expect(() => parseCanonicalInput({ id: "a1", inputCanonical: text })).toThrow(
      CanonicalInputError,
    );
    expect(() => parseCanonicalInput({ id: "a1", inputCanonical: text })).toThrow(/a1/);
  });
});

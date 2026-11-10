import { describe, expect, it } from "vitest";
import { patternChoices, patternCovers } from "./egress-patterns";

describe("patternChoices", () => {
  it("offers the host first, then each parent wildcard with two labels after *.", () => {
    expect(patternChoices("a.b.example.com")).toEqual([
      "a.b.example.com",
      "*.b.example.com",
      "*.example.com",
    ]);
  });
  it("offers no wildcard for a registrable name or a bare suffix", () => {
    expect(patternChoices("example.com")).toEqual(["example.com"]);
    expect(patternChoices("localhost")).toEqual(["localhost"]);
  });
  it("never offers a two-level public suffix", () => {
    expect(patternChoices("www.example.co.uk")).toEqual(["www.example.co.uk", "*.example.co.uk"]);
  });
  it("lowercases", () => {
    expect(patternChoices("Api.Example.COM")).toEqual(["api.example.com", "*.example.com"]);
  });
});

describe("patternCovers", () => {
  it("matches exact and wildcard patterns like the server", () => {
    expect(patternCovers("a.example.com", "a.example.com")).toBe(true);
    expect(patternCovers("*.example.com", "a.b.example.com")).toBe(true);
    expect(patternCovers("*.example.com", "example.com")).toBe(false);
    expect(patternCovers("a.example.com", "b.example.com")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { lineDiff, splitLines } from "./line-diff";

const kinds = (a: string, b: string) => lineDiff(a, b).map((r) => `${r.kind}:${r.text}`);

describe("lineDiff", () => {
  it("shows a new file as all added", () => {
    expect(kinds("", "a\nb\n")).toEqual(["added:a", "added:b"]);
  });
  it("keeps common lines and marks a changed one", () => {
    expect(kinds("a\nb\nc\n", "a\nB\nc\n")).toEqual(["same:a", "removed:b", "added:B", "same:c"]);
  });
  it("finds inserts and deletes in the middle", () => {
    expect(kinds("a\nx\nb\ny\nc", "a\nb\nz\nc")).toEqual([
      "same:a",
      "removed:x",
      "same:b",
      "removed:y",
      "added:z",
      "same:c",
    ]);
  });
  it("is empty for equal texts and handles a trailing newline", () => {
    expect(lineDiff("a\n", "a\n").every((r) => r.kind === "same")).toBe(true);
    expect(splitLines("a\n")).toEqual(["a"]);
    expect(splitLines("")).toEqual([]);
  });
  it("falls back to remove-all then add-all for a huge rewrite", () => {
    const a = Array.from({ length: 2500 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 2500 }, (_, i) => `b${i}`).join("\n");
    const rows = lineDiff(a, b);
    expect(rows.filter((r) => r.kind === "removed")).toHaveLength(2500);
    expect(rows.filter((r) => r.kind === "added")).toHaveLength(2500);
  });
});

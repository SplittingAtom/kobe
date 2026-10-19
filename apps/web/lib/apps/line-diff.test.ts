import { describe, expect, it } from "vitest";
import { lineDiff } from "./line-diff";

describe("lineDiff (KOBE-434 escaped source diff)", () => {
  it("marks kept, removed and added lines", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "x" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ]);
  });

  it("handles an empty side and identical texts", () => {
    expect(lineDiff("", "a")).toEqual([
      { kind: "removed", text: "" },
      { kind: "added", text: "a" },
    ]);
    expect(lineDiff("a\nb", "a\nb")).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
    ]);
  });

  it("falls back to removed-then-added blocks when the middle is too large to align", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
    const diff = lineDiff(`top\n${a}\nend`, `top\n${b}\nend`);
    expect(diff[0]).toEqual({ kind: "same", text: "top" });
    expect(diff[1]).toEqual({ kind: "removed", text: "a0" });
    expect(diff[3001]).toEqual({ kind: "added", text: "b0" });
    expect(diff.at(-1)).toEqual({ kind: "same", text: "end" });
  });
});

import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MAX_PATCH_LINES, MAX_TEXT_BYTES, diffPackages } from "./review-diff.js";

const zip = (files: Record<string, string | Uint8Array>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([p, v]) => [p, typeof v === "string" ? strToU8(v) : v]),
    ),
  );

describe("diffPackages (KOBE-334, SK23)", () => {
  it("lists every file of a new skill as added, with its lines", () => {
    const d = diffPackages(null, zip({ "SKILL.md": "a\nb\n", "evals/cases.yaml": "x\n" }));
    expect(d.files.map((f) => [f.path, f.status])).toEqual([
      ["SKILL.md", "added"],
      ["evals/cases.yaml", "added"],
    ]);
    expect(d.changedFiles).toBe(2);
    expect(d.files[0]?.hunks[0]?.lines).toEqual(["+a", "+b"]);
  });

  it("puts changed files first and diffs them line by line", () => {
    const before = zip({ "SKILL.md": "one\ntwo\nthree\n", "old.py": "x\n", "same.txt": "s\n" });
    const after = zip({ "SKILL.md": "one\nTWO\nthree\n", "new.py": "y\n", "same.txt": "s\n" });
    const d = diffPackages(before, after);
    expect(d.files.map((f) => [f.path, f.status])).toEqual([
      ["SKILL.md", "changed"],
      ["new.py", "added"],
      ["old.py", "removed"],
      ["same.txt", "unchanged"],
    ]);
    expect(d.changedFiles).toBe(3);
    expect(d.files[0]?.hunks[0]?.lines).toEqual([" one", "-two", "+TWO", " three"]);
    expect(d.files[3]?.hunks).toEqual([]);
    expect(d.truncated).toBe(false);
  });

  it("shows binary and oversized files by status only", () => {
    const big = "z\n".repeat(MAX_TEXT_BYTES);
    const d = diffPackages(
      zip({ "a.bin": new Uint8Array([0, 1, 2]), "big.txt": "small\n" }),
      zip({ "a.bin": new Uint8Array([0, 1, 3]), "big.txt": big }),
    );
    expect(d.files.map((f) => [f.path, f.status, f.binary, f.hunks.length])).toEqual([
      ["a.bin", "changed", true, 0],
      ["big.txt", "changed", true, 0],
    ]);
  });

  it("stops patching at the line budget and says so", () => {
    const lines = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => `${tag}${i}`).join("\n");
    const half = Math.ceil(MAX_PATCH_LINES / 2) + 1;
    const d = diffPackages(
      zip({}),
      zip({ "a.txt": lines(half, "a"), "b.txt": lines(half, "b"), "c.txt": "c\n" }),
    );
    expect(d.truncated).toBe(true);
    expect(d.files.find((f) => f.path === "c.txt")?.hunks).toEqual([]);
  });
});

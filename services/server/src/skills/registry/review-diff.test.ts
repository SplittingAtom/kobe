import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  MAX_DIFF_LINES,
  MAX_PATCH_LINES,
  MAX_TEXT_BYTES,
  changedFileCount,
  diffPackages,
} from "./review-diff.js";

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
    expect(d.files.map((f) => [f.path, f.status, f.binary, f.notDiffed, f.hunks.length])).toEqual([
      ["a.bin", "changed", true, undefined, 0],
      ["big.txt", "changed", false, "too_large", 0],
    ]);
  });

  it("never stalls on files that differ everywhere (review H1)", () => {
    const lines = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => `${tag}-${i}-${"x".repeat(4)}`).join("\n");
    // The review's case: two 180 KB files where every line differs.
    const started = Date.now();
    const huge = diffPackages(
      zip({ "data.csv": lines(20_000, "a") }),
      zip({ "data.csv": lines(20_000, "b") }),
    );
    expect(huge.files[0]?.notDiffed).toBe("too_large");
    // Under the line cap but different everywhere: the diff gives up in time.
    const n = MAX_DIFF_LINES - 1;
    const many = diffPackages(
      zip({ "a.txt": lines(n, "a"), "b.txt": lines(n, "c"), "c.txt": lines(n, "e") }),
      zip({ "a.txt": lines(n, "b"), "b.txt": lines(n, "d"), "c.txt": lines(n, "f") }),
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    for (const f of many.files)
      expect(["too_different", "skipped", undefined]).toContain(f.notDiffed);
  });

  it("counts changed files by bytes alone", () => {
    expect(
      changedFileCount(
        zip({ "SKILL.md": "a\n", "same.txt": "s\n", "gone.txt": "g\n" }),
        zip({ "SKILL.md": "b\n", "same.txt": "s\n", "new.txt": "n\n" }),
      ),
    ).toBe(3);
    expect(changedFileCount(null, zip({ "SKILL.md": "a\n" }))).toBe(1);
  });

  it("stops patching at the line budget and says so", () => {
    const lines = (tag: string) =>
      Array.from({ length: MAX_DIFF_LINES - 1 }, (_, i) => `${tag}${i}`).join("\n");
    const files = Object.fromEntries(
      Array.from({ length: Math.ceil(MAX_PATCH_LINES / (MAX_DIFF_LINES - 1)) + 1 }, (_, i) => [
        `f${i}.txt`,
        lines(`f${i}-`),
      ]),
    );
    const d = diffPackages(zip({}), zip(files));
    expect(d.truncated).toBe(true);
    expect(d.files.at(-1)?.notDiffed).toBe("skipped");
  });
});

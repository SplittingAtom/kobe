import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  areaOf,
  attachmentDisposition,
  copyPath,
  isInternalPath,
  isReadOnlyPath,
  underPattern,
} from "./paths.js";

describe("workspace file browser paths", () => {
  it("names the area of files and folders", () => {
    expect(areaOf("notes.md")).toBe("workspace");
    expect(areaOf("uploads")).toBe("uploads");
    expect(areaOf("uploads/t/f")).toBe("uploads");
    expect(areaOf("projects/p")).toBe("projects");
    expect(areaOf("uploadsX/f")).toBe("workspace");
    expect(isReadOnlyPath("projects")).toBe(true);
    expect(isReadOnlyPath("src/uploads/f")).toBe(false);
  });

  it("opens only a member's drop in uploads/ (KOBE-199)", () => {
    expect(isReadOnlyPath("uploads/brief.pdf")).toBe(false);
    expect(areaOf("uploads/brief.pdf")).toBe("uploads");
    for (const path of ["uploads", "uploads/t/f", "uploads/0b7f3c1e-2d4a-4e5b-8c6d-7e8f9a0b1c2d"]) {
      expect(isReadOnlyPath(path), path).toBe(true);
    }
  });

  it("names copies before the extension, trimming the stem to the segment limit", () => {
    expect(copyPath("uploads/report.pdf", 1)).toBe("uploads/report (1).pdf");
    expect(copyPath("uploads/archive.tar.gz", 2)).toBe("uploads/archive.tar (2).gz");
    expect(copyPath("uploads/.env", 3)).toBe("uploads/.env (3)");
    expect(copyPath("README", 4)).toBe("README (4)");
    const long = copyPath(`uploads/${"é".repeat(127)}.pdf`, 12);
    const name = long.slice("uploads/".length);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    expect(name.endsWith(" (12).pdf")).toBe(true);
    const hugeExt = copyPath(`a.${"x".repeat(252)}`, 1);
    expect(new TextEncoder().encode(hugeExt).length).toBeLessThanOrEqual(255);
    expect(hugeExt.endsWith(" (1)")).toBe(true);
  });

  it("knows the agent-internal area", () => {
    expect(isInternalPath(".kobe")).toBe(true);
    expect(isInternalPath(".kobe/session.jsonl")).toBe(true);
    expect(isInternalPath(".kobex/f")).toBe(false);
  });

  it("lists ancestors", () => {
    expect(ancestorsOf("a")).toEqual([]);
    expect(ancestorsOf("a/b/c.txt")).toEqual(["a", "a/b"]);
  });

  it("escapes LIKE wildcards in folder patterns", () => {
    expect(underPattern("")).toBe("%");
    expect(underPattern("a_b/%c")).toBe("a\\_b/\\%c/%");
  });

  it("builds a safe attachment header", () => {
    const h = attachmentDisposition('x/na"me;\\ \u00e9\r\n.txt');
    expect(h.startsWith("attachment; filename=")).toBe(true);
    expect(h).not.toMatch(/[\r\n]/);
    expect(h).toContain("filename*=UTF-8''na%22me%3B%5C%20%C3%A9%0D%0A.txt");
  });
});

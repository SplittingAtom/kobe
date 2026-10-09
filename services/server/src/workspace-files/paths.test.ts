import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  areaOf,
  attachmentDisposition,
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

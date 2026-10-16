import { describe, expect, it } from "vitest";
import {
  decodeMentionPath,
  encodeMentionPath,
  findMentionMarkers,
  mentionMarker,
  sandboxPathOf,
  workspaceSearchQuerySchema,
  WORKSPACE_SEARCH_MAX_RESULTS,
} from "./index.js";

describe("@file mention markers (KOBE-223)", () => {
  it("keeps a plain path readable", () => {
    expect(mentionMarker("data/sales q3.csv")).toBe("@file(data/sales%20q3.csv)");
    expect(mentionMarker("reports/Übersicht.pdf")).toBe("@file(reports/Übersicht.pdf)");
  });

  it("encodes the marker's delimiters, % and invisible characters", () => {
    expect(encodeMentionPath("a(1)%.txt")).toBe("a%281%29%25.txt");
    expect(encodeMentionPath("a​b\tc")).toBe("a%E2%80%8Bb%09c");
  });

  it("round-trips any path through find + decode", () => {
    for (const path of ["a.txt", "dir/x (copy).md", "100% done/ü x", "a)b(c"]) {
      const [found] = findMentionMarkers(`see ${mentionMarker(path)} please`);
      expect(found?.raw).toBe(mentionMarker(path));
      expect(decodeMentionPath(found?.encoded ?? "")).toBe(path);
    }
  });

  it("finds every marker in order, and nothing in ordinary text", () => {
    const text = "compare @file(a.csv) with @file(b/c.csv), not @file() or @alice or file(x)";
    expect(findMentionMarkers(text).map((m) => m.encoded)).toEqual(["a.csv", "b/c.csv"]);
    expect(findMentionMarkers(text)[1]?.index).toBe(text.indexOf("@file(b/c.csv)"));
  });

  it("decodes once and refuses malformed encodings", () => {
    expect(decodeMentionPath("a%252e")).toBe("a%2e");
    expect(decodeMentionPath("a%2")).toBeUndefined();
    expect(decodeMentionPath("%FF")).toBeUndefined();
    // NUL decodes; the server's path rules refuse it.
    expect(decodeMentionPath("%00")).toBe("\u0000");
  });

  it("names the absolute sandbox path", () => {
    expect(sandboxPathOf("uploads/t/x.txt")).toBe("/workspace/uploads/t/x.txt");
  });
});

describe("workspace search query (KOBE-223)", () => {
  it("accepts a query and a limit up to the cap", () => {
    expect(workspaceSearchQuerySchema.parse({ q: "sales", limit: "10" })).toEqual({
      q: "sales",
      limit: 10,
    });
    expect(workspaceSearchQuerySchema.parse({})).toEqual({});
  });

  it("refuses control characters, oversize limits and unknown parameters", () => {
    expect(workspaceSearchQuerySchema.safeParse({ q: "a\u0000" }).success).toBe(false);
    expect(
      workspaceSearchQuerySchema.safeParse({ limit: String(WORKSPACE_SEARCH_MAX_RESULTS + 1) })
        .success,
    ).toBe(false);
    expect(workspaceSearchQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(workspaceSearchQuerySchema.safeParse({ path: "x" }).success).toBe(false);
  });
});

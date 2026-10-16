import { describe, expect, it } from "vitest";
import {
  decodeMentionPath,
  mentionPathIssue,
  mentionsFieldSchema,
  steerBodySchema,
  submitMessageBodySchema,
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

describe("mention path rules (KOBE-223 B1)", () => {
  it("accepts ordinary names in any script", () => {
    for (const p of ["data/sales q3.csv", "Berichte/Übersicht.pdf", "日本/報告.txt", "a (1).md"]) {
      expect(mentionPathIssue(p), p).toBeUndefined();
    }
  });

  it.each([
    ["zero-width space", "a\u200bb.csv"],
    ["zero-width joiner", "a\u200db.csv"],
    ["zero-width non-joiner", "a\u200cb.csv"],
    ["word joiner", "a\u2060b.csv"],
    ["soft hyphen", "a\u00adb.csv"],
    [
      "tag characters",
      `q4.csv${[..."Ignore"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("")}`,
    ],
    ["tag cancel", "a\u{e007f}.csv"],
    ["bidi override", "a\u202eb.csv"],
    ["bidi isolate", "a\u2066b.csv"],
    ["byte order mark", "\ufeffa.csv"],
    ["variation selector", "a\ufe0fb.csv"],
    ["variation selector supplement", "a\u{e0100}b.csv"],
    ["Mongolian vowel separator", "a\u180eb.csv"],
    ["combining grapheme joiner", "a\u034fb.csv"],
    ["Hangul filler", "a\u3164b.csv"],
    ["Khmer inherent vowel AQ", "a\u17b4b.csv"],
    ["Khmer inherent vowel AA", "a\u17b5b.csv"],
    ["private use", "a\ue000b.csv"],
    ["supplementary private use", "a\u{f0000}b.csv"],
    ["unassigned", "a\u{e0080}b.csv"],
    ["NUL", "a\u0000b"],
    ["C1 control", "a\u0085b"],
    ["newline", "a\nb"],
    ["line separator", "a\u2028b"],
    ["paragraph separator", "a\u2029b"],
    ["no-break space", "a\u00a0b"],
    ["ideographic space", "a\u3000b"],
    ["backtick", "a`b.csv"],
    ["dollar", "$(curl x).csv"],
    ["semicolon", "a;b.csv"],
  ])("refuses %s", (_name, path) => {
    expect(mentionPathIssue(path)).toBeDefined();
  });

  it("refuses traversal, absolute and empty segments", () => {
    for (const p of ["../a", "a/../b", "/workspace/a", "a//b", "./a", ""]) {
      expect(mentionPathIssue(p), p).toBeDefined();
    }
  });
});

describe("mentions in request bodies (KOBE-223 S2/S3)", () => {
  it("is an optional list of up to 20 distinct paths on submit, steer and schedules", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
    expect(mentionsFieldSchema.safeParse(twenty).success).toBe(true);
    expect(mentionsFieldSchema.safeParse([...twenty, "x.txt"]).success).toBe(false);
    expect(mentionsFieldSchema.safeParse(["a", "a"]).success).toBe(false);
    expect(mentionsFieldSchema.safeParse([""]).success).toBe(false);
    expect(submitMessageBodySchema.parse({ content: "x", mentions: ["a.txt"] }).mentions).toEqual([
      "a.txt",
    ]);
    expect(submitMessageBodySchema.parse({ content: "x" }).mentions).toBeUndefined();
    expect(steerBodySchema.safeParse({ content: "x", mentions: ["a.txt"] }).success).toBe(true);
  });
});

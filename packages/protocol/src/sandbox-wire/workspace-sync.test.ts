import { describe, expect, it } from "vitest";
import {
  isExcludedPath,
  isServerOwnedPath,
  workspaceChangeSchema,
  workspaceEntrySchema,
  workspacePathIssue,
} from "./workspace-sync.js";

const SHA = "a".repeat(64);

describe("workspace sync contract", () => {
  it("accepts ordinary relative paths", () => {
    for (const p of [
      "report.md",
      "out/charts/q3.html",
      "uploads/t1/sales data.csv",
      "é/ü.txt",
      "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645.txt", // Persian with ZWNJ
    ]) {
      expect(workspacePathIssue(p)).toBeUndefined();
    }
  });

  it("refuses paths that could escape or confuse the workspace", () => {
    for (const p of [
      "",
      "/etc/passwd",
      "../x",
      "a/../b",
      "a/./b",
      "a//b",
      "a/",
      "a\\b",
      "a\u0000b",
      "a\nb",
      "invoice\u202Efdp.exe", // right-to-left override
      "a\u2066b", // left-to-right isolate
      "x".repeat(256),
      `${"a/".repeat(600)}b`,
    ]) {
      expect(workspacePathIssue(p), p).toBeDefined();
    }
  });

  it("names the server-owned and excluded areas", () => {
    expect(isServerOwnedPath("uploads/t/a.csv")).toBe(true);
    expect(isServerOwnedPath("projects/acme/spec.md")).toBe(true);
    expect(isServerOwnedPath("uploadsx/a")).toBe(false);
    expect(isExcludedPath(".kobe/sessions/t.jsonl")).toBe(true);
    expect(isExcludedPath(".kobe")).toBe(true);
    expect(isExcludedPath(".kobex")).toBe(false);
  });

  it("parses entries and changes strictly", () => {
    const entry = {
      path: "a.txt",
      rev: 3,
      deleted: false,
      sha256: SHA,
      size: 5,
      mtime_ms: 1,
      executable: false,
      origin: "sandbox",
      updated_ms: 2,
    };
    expect(workspaceEntrySchema.parse(entry)).toEqual(entry);
    expect(() => workspaceEntrySchema.parse({ ...entry, key: "teams/x" })).toThrow();
    expect(() => workspaceEntrySchema.parse({ ...entry, sha256: SHA.toUpperCase() })).toThrow();
    expect(workspaceChangeSchema.parse({ op: "delete", path: "a.txt", base_rev: 3 })).toMatchObject(
      { op: "delete" },
    );
    expect(() =>
      workspaceChangeSchema.parse({ op: "put", path: "../a", base_rev: null, sha256: SHA }),
    ).toThrow();
  });
});

describe("workspace entry header", () => {
  it("round-trips an entry with a UTF-8 path and refuses junk", async () => {
    const { encodeWorkspaceEntryHeader, decodeWorkspaceEntryHeader } =
      await import("./workspace-sync.js");
    const entry = {
      path: "rapports/été €.md",
      rev: 9,
      deleted: false,
      sha256: "c".repeat(64),
      size: 10,
      mtime_ms: 5,
      executable: true,
      origin: "server" as const,
      updated_ms: 6,
    };
    const header = encodeWorkspaceEntryHeader(entry);
    expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeWorkspaceEntryHeader(header)).toEqual(entry);
    expect(decodeWorkspaceEntryHeader("not base64!")).toBeUndefined();
    expect(decodeWorkspaceEntryHeader(undefined)).toBeUndefined();
  });
});

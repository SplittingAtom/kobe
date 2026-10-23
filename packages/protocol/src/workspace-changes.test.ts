import { describe, expect, it } from "vitest";
import {
  formatWorkspaceChange,
  WORKSPACE_CHANGES_MAX_PATHS,
  workspaceChangesQuerySchema,
  workspaceFileChangeSchema,
} from "./workspace-changes.js";

const SHA = "a".repeat(64);
const TEAM = "0b7c3f8e-1d2a-4c5b-9e6f-7a8b9c0d1e2f";

describe("workspace changes contract (KOBE-496)", () => {
  it("accepts a change, a deletion and a never-seen path", () => {
    const changed = {
      path: "notes/plan.md",
      sha256: SHA,
      rev: 7,
      actor: { kind: "agent", name: null },
      at: "2026-10-23T10:00:00.123Z",
    };
    expect(workspaceFileChangeSchema.parse(changed)).toEqual(changed);
    expect(
      workspaceFileChangeSchema.safeParse({ ...changed, sha256: null, actor: null, at: null })
        .success,
    ).toBe(true);
  });

  it("refuses unknown fields, actors and bad paths", () => {
    const base = { path: "a.md", sha256: SHA, rev: 1, actor: null, at: null };
    expect(workspaceFileChangeSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(
      workspaceFileChangeSchema.safeParse({ ...base, actor: { kind: "admin", name: null } })
        .success,
    ).toBe(false);
    expect(workspaceFileChangeSchema.safeParse({ ...base, path: "../x" }).success).toBe(false);
  });

  it("bounds the path set and needs the team", () => {
    expect(workspaceChangesQuerySchema.safeParse({ team: TEAM, path: ["a.md"] }).success).toBe(
      true,
    );
    expect(workspaceChangesQuerySchema.safeParse({ team: TEAM, path: [] }).success).toBe(false);
    expect(workspaceChangesQuerySchema.safeParse({ path: ["a.md"] }).success).toBe(false);
    const many = Array.from({ length: WORKSPACE_CHANGES_MAX_PATHS + 1 }, (_, i) => `f${i}.md`);
    expect(workspaceChangesQuerySchema.safeParse({ team: TEAM, path: many }).success).toBe(false);
  });

  it("frames one SSE message on a single data line", () => {
    const text = formatWorkspaceChange("file.changed", {
      path: "a b.md",
      sha256: SHA,
      rev: 2,
      actor: { kind: "user", name: "Ann\nLee" },
      at: "2026-10-23T10:00:00Z",
    });
    expect(text.startsWith("event: file.changed\ndata: ")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(true);
    expect(text.split("\n")).toHaveLength(4);
  });
});

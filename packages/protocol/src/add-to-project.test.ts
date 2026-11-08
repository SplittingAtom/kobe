import { describe, expect, it } from "vitest";
import {
  artifactFileStem,
  artifactMimeType,
  canAddToProject,
  importProjectFileRequestSchema,
} from "./index.js";

const ID = "11111111-1111-4111-8111-111111111111";

/** KOBE-585: who may Add to project (Chris 2026-11-08: editors are builders). */
describe("canAddToProject", () => {
  it("lets team admins and project owners add anything they can read", () => {
    expect(canAddToProject("team_admin", undefined, false)).toBe(true);
    expect(canAddToProject("team_admin", "member", false)).toBe(true);
    expect(canAddToProject("member", "owner", false)).toBe(true);
  });

  it("lets a builder project member add content they do not own", () => {
    expect(canAddToProject("builder", "member", false)).toBe(true);
    expect(canAddToProject("builder", undefined, false)).toBe(false);
    expect(canAddToProject("builder", undefined, true)).toBe(false);
  });

  it("lets a plain member add only their own content, and only as a project member", () => {
    expect(canAddToProject("member", "member", true)).toBe(true);
    expect(canAddToProject("member", "member", false)).toBe(false);
    expect(canAddToProject("member", undefined, true)).toBe(false);
  });
});

describe("importProjectFileRequestSchema", () => {
  it("takes an artifact version or a workspace path, with optional folder and name", () => {
    expect(
      importProjectFileRequestSchema.safeParse({
        source: { kind: "artifact", artifact_id: ID, version: 2 },
        folder: "docs",
        name: "plan.md",
      }).success,
    ).toBe(true);
    expect(
      importProjectFileRequestSchema.safeParse({
        source: { kind: "workspace_file", path: "notes/a.txt" },
      }).success,
    ).toBe(true);
  });

  it("refuses traversal, bad versions, names with slashes and unknown keys", () => {
    const bad = [
      { source: { kind: "workspace_file", path: "../x" } },
      { source: { kind: "artifact", artifact_id: ID, version: 0 } },
      { source: { kind: "artifact", artifact_id: ID, version: 1 }, name: "a/b.md" },
      { source: { kind: "workspace_file", path: "a.txt" }, overwrite: true },
      { source: { kind: "other" } },
    ];
    for (const body of bad)
      expect(importProjectFileRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("artifact file names and types (KOBE-585)", () => {
  it("derives a safe stem and the stored media type from kind and language", () => {
    expect(artifactFileStem("Q3 Plan: draft!")).toBe("q3-plan-draft");
    expect(artifactFileStem("!!!")).toBe("artifact");
    expect(artifactMimeType("markdown", null)).toBe("text/markdown");
    expect(artifactMimeType("html", null)).toBe("text/html");
    expect(artifactMimeType("code", "json")).toBe("application/json");
    expect(artifactMimeType("code", "python")).toBe("text/plain");
    expect(artifactMimeType("mermaid", null)).toBe("text/plain");
  });
});

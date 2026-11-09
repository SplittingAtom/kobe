import { describe, expect, it } from "vitest";
import type { Project } from "./api";
import {
  dropRefusal,
  effectiveRole,
  isProjectFolder,
  projectFileAccess,
  projectSlugOf,
} from "./workspace";

const project = (slug: string, over: Partial<Project> = {}): Project => ({
  id: `p-${slug}`,
  teamId: "t-1",
  slug,
  name: slug.toUpperCase(),
  description: "",
  instructions: "",
  defaultAgentId: null,
  visibility: "workspace",
  myRole: "editor",
  fileCount: 0,
  createdBy: "u-1",
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  archivedAt: null,
  ...over,
});

describe("projects in the scratchspace (FP1-FP3)", () => {
  it("finds the project of a path", () => {
    expect(projectSlugOf("projects/budget/a/b.csv")).toBe("budget");
    expect(projectSlugOf("projects/budget")).toBe("budget");
    expect(projectSlugOf("projects")).toBeUndefined();
    expect(projectSlugOf("notes/projects/x")).toBeUndefined();
    expect(isProjectFolder("projects/budget")).toBe(true);
    expect(isProjectFolder("projects/budget/a.md")).toBe(false);
  });

  it("a team admin who is not listed acts as owner", () => {
    expect(effectiveRole(project("a", { myRole: null }))).toBe("owner");
    expect(effectiveRole(project("a", { myRole: "reader" }))).toBe("reader");
  });

  it("checked out, editable, readable", () => {
    const bySlug = new Map([
      ["mine", project("mine")],
      ["read", project("read", { myRole: "reader" })],
      ["old", project("old", { archivedAt: "2026-11-02T00:00:00Z" })],
    ]);
    const out = new Set(["mine"]);
    expect(projectFileAccess("notes.md", bySlug, out).kind).toBe("none");
    expect(projectFileAccess("projects/mine/a.md", bySlug, out).kind).toBe("checked_out");
    expect(projectFileAccess("projects/mine/a.md", bySlug, new Set()).kind).toBe("editable");
    expect(projectFileAccess("projects/read/a.md", bySlug, out).kind).toBe("readable");
    expect(projectFileAccess("projects/old/a.md", bySlug, out).kind).toBe("readable");
    expect(projectFileAccess("projects/unknown/a.md", bySlug, out).kind).toBe("readable");
    // A checkout of an archived or unknown project never makes it writable.
    expect(projectFileAccess("projects/old/a.md", bySlug, new Set(["old"])).kind).toBe("readable");
    expect(projectFileAccess("projects/gone/a.md", bySlug, new Set(["gone"])).kind).toBe(
      "readable",
    );
  });

  it("explains a refused drop by role", () => {
    const bySlug = new Map([
      ["mine", project("mine")],
      ["read", project("read", { myRole: "reader" })],
    ]);
    expect(dropRefusal(projectFileAccess("projects/mine", bySlug, new Set()))).toMatch(
      /^Check out to edit/,
    );
    expect(dropRefusal(projectFileAccess("projects/read", bySlug, new Set()))).toBe(
      "You can read this project, not change it.",
    );
    expect(dropRefusal(projectFileAccess("projects/mine", bySlug, new Set(["mine"])))).toBe(
      undefined,
    );
  });
});

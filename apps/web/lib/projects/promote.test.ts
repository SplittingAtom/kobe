import { describe, expect, it } from "vitest";
import type { FileEntry } from "../files/api";
import { canCreateProjects, offersPromote, promoteNameProblem } from "./promote";

const dir = (path: string, area: FileEntry["area"]): FileEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  type: "dir",
  sizeBytes: null,
  mtime: "",
  source: "synced",
  area,
});

/** KOBE-586 (PF1, PF2): who sees Promote to project…, on which rows, and the name's rule. */
describe("Promote to project (PF1)", () => {
  it("is for team admins and contributors only", () => {
    expect(canCreateProjects("team_admin")).toBe(true);
    expect(canCreateProjects("contributor")).toBe(true);
    expect(canCreateProjects("member")).toBe(false);
    expect(canCreateProjects(null)).toBe(false);
  });

  it("is offered on My files folders only", () => {
    expect(offersPromote(dir("notes", "workspace"), true)).toBe(true);
    expect(offersPromote(dir("notes/q3", "workspace"), true)).toBe(true);
    expect(offersPromote(dir("notes", "workspace"), false)).toBe(false);
    expect(offersPromote(dir("uploads", "uploads"), true)).toBe(false);
    expect(offersPromote(dir("projects/budget", "projects"), true)).toBe(false);
    expect(offersPromote({ ...dir("a.md", "workspace"), type: "file" }, true)).toBe(false);
  });

  it("asks for a name of 1 to 100 characters (PF2)", () => {
    expect(promoteNameProblem("Q3 report")).toBeNull();
    expect(promoteNameProblem("   ")).toBe("Type a name for the project.");
    expect(promoteNameProblem("x".repeat(101))).toContain("100");
  });
});

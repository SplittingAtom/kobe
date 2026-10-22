import { describe, expect, it } from "vitest";
import { folderPath, newFolderProblem, newPathProblem } from "./paths";

describe("newPathProblem (KOBE-321)", () => {
  const others = ["SKILL.md", "references/guide.md", "scripts"];

  it("accepts an ordinary new path", () => {
    expect(newPathProblem("references/notes.md", others)).toBeNull();
    expect(newPathProblem("evals/cases.yaml", others)).toBeNull();
  });

  it("explains each refusal in words", () => {
    expect(newPathProblem("references/guide.md", others)).toMatch(/already/);
    expect(newPathProblem("References/Guide.md", others)).toMatch(/different case/);
    expect(newPathProblem("/etc/passwd", others)).toMatch(/relative/);
    expect(newPathProblem("a/../b.md", others)).toMatch(/\.\./);
    expect(newPathProblem("a\\b.md", others)).toMatch(/\//);
    expect(newPathProblem("Evals/x.yaml", others)).toMatch(/spell them exactly/);
    expect(newPathProblem("provenance.json", others)).toMatch(/Kobe writes/);
    expect(newPathProblem("scripts/run.sh", others)).toMatch(/file and a folder/);
    expect(newPathProblem("", others)).toMatch(/Give the file a path/);
  });
});

describe("newFolderProblem (KOBE-478)", () => {
  const paths = ["SKILL.md", "references/guide.md", "scripts"];

  it("accepts a new folder, nested ones and a trailing /", () => {
    expect(newFolderProblem("templates", paths, [])).toBeNull();
    expect(newFolderProblem("references/more", paths, [])).toBeNull();
    expect(newFolderProblem("a/b/c/", paths, ["a/b"])).toBeNull();
    expect(newFolderProblem("evals", paths, [])).toBeNull();
  });

  it("explains each refusal in words", () => {
    expect(newFolderProblem("", paths, [])).toMatch(/Give the folder a name/);
    expect(newFolderProblem("/", paths, [])).toMatch(/Give the folder a name/);
    expect(newFolderProblem("references", paths, [])).toMatch(/already/);
    expect(newFolderProblem("templates", paths, ["templates"])).toMatch(/already/);
    expect(newFolderProblem("scripts", paths, [])).toMatch(/file has this name/);
    expect(newFolderProblem("References", paths, [])).toMatch(/different case/);
    expect(newFolderProblem("../up", paths, [])).toMatch(/\.\./);
    expect(newFolderProblem("a//b", paths, [])).toMatch(/\.\./);
    expect(newFolderProblem("/etc", paths, [])).toMatch(/relative/);
    expect(newFolderProblem("a\\b", paths, [])).toMatch(/\//);
    expect(newFolderProblem("Evals", paths, [])).toMatch(/spell them exactly/);
  });
});

describe("folderPath (KOBE-478)", () => {
  it("trims the name and drops one trailing /", () => {
    expect(folderPath("  templates/ ")).toBe("templates");
    expect(folderPath("a/b")).toBe("a/b");
  });
});

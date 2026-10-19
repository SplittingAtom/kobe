import { describe, expect, it } from "vitest";
import { newPathProblem } from "./paths";

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

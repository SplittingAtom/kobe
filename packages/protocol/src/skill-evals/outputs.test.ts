import { describe, expect, it } from "vitest";
import {
  checkEvalOutputs,
  EVAL_OUTPUT_MAX_MATCHES,
  EVAL_WORKSPACE_MAX_FILES,
  isReservedWorkspacePath,
  producedFiles,
  type EvalWorkspaceEntry,
  type EvalWorkspaceSnapshot,
} from "./entry.js";

const sha = (c: string) => c.repeat(64);
const file = (path: string, hash = "a", size = 10): EvalWorkspaceEntry => ({
  path,
  type: "file",
  size,
  sha256: sha(hash),
});
const snap = (entries: EvalWorkspaceEntry[], truncated = false): EvalWorkspaceSnapshot => ({
  entries,
  truncated,
});
const EMPTY = snap([]);

describe("what an outputs glob matches (KOBE-324 B1)", () => {
  it("reserves skills/ and hidden segments at any depth", () => {
    for (const p of [".kobe/sessions/x.jsonl", "skills/a/SKILL.md", "out/.cache/x", "a/skills/b"])
      expect(isReservedWorkspacePath(p), p).toBe(true);
    for (const p of ["outputs/q3.xlsx", "out/skills.csv", "notes.md"])
      expect(isReservedWorkspacePath(p), p).toBe(false);
  });

  it("never lets a wildcard reach Kobe's or Pi's state", () => {
    const after = snap([
      file(".kobe/sessions/run.jsonl"),
      file("skills/report/SKILL.md"),
      file("out/.cache/x.jsonl"),
    ]);
    for (const glob of ["*", "*.jsonl", "?kobe/*", "s*/x", "*/SKILL.md"])
      expect(checkEvalOutputs([glob], EMPTY, after), glob).toMatchObject({
        passed: false,
        reason: "not_produced",
      });
  });

  it("counts a file the run created or changed, never an unchanged fixture", () => {
    const before = snap([file("outputs/q3.xlsx", "a"), file("sales.csv", "b")]);
    expect(checkEvalOutputs(["outputs/*.xlsx"], before, before)).toMatchObject({
      passed: false,
      reason: "not_produced",
    });
    const edited = snap([file("outputs/q3.xlsx", "c"), file("sales.csv", "b")]);
    expect(checkEvalOutputs(["outputs/*.xlsx"], before, edited)).toMatchObject({ passed: true });
    const created = snap([...before.entries, file("outputs/q4.xlsx", "d")]);
    const result = checkEvalOutputs(["outputs/*.xlsx"], before, created);
    expect(result.passed).toBe(true);
    expect(result.files.map((f) => f.path)).toEqual(["outputs/q4.xlsx"]);
  });

  it("never counts a symbolic link or another kind of entry", () => {
    const after = snap([
      { path: "outputs/x.xlsx", type: "symlink", size: 0, sha256: "" },
      { path: "outputs/y.xlsx", type: "other", size: 0, sha256: "" },
    ]);
    expect(producedFiles(EMPTY, after)).toEqual([]);
    expect(checkEvalOutputs(["outputs/*"], EMPTY, after).passed).toBe(false);
  });

  it("needs every glob matched and fails over the caps with a reason", () => {
    const after = snap([file("out/a.png"), file("out/b.csv")]);
    expect(checkEvalOutputs(["out/*.png", "out/*.csv"], EMPTY, after).passed).toBe(true);
    expect(checkEvalOutputs(["out/*.png", "out/*.pdf"], EMPTY, after)).toMatchObject({
      passed: false,
      detail: "no produced file matches out/*.pdf",
    });
    const many = snap(
      Array.from({ length: EVAL_OUTPUT_MAX_MATCHES + 1 }, (_, i) => file(`out/${i}.png`)),
    );
    expect(checkEvalOutputs(["out/*"], EMPTY, many)).toMatchObject({ reason: "over_cap" });
    const big = snap([file("out/a.bin", "a", 51 * 1024 * 1024)]);
    expect(checkEvalOutputs(["out/*"], EMPTY, big)).toMatchObject({ reason: "over_cap" });
    expect(checkEvalOutputs(["out/*"], EMPTY, snap([file("out/a")], true))).toMatchObject({
      reason: "over_cap",
      detail: `the workspace holds more than ${EVAL_WORKSPACE_MAX_FILES} entries`,
    });
  });
});

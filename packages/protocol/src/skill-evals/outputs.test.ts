import { describe, expect, it } from "vitest";
import {
  checkEvalOutputs,
  EVAL_OUTPUT_MAX_MATCHES,
  EVAL_WORKSPACE_MAX_FILES,
  evalOutputWalkRoot,
  evalOutputWalkRoots,
  evalWorkspaceEntrySchema,
  isReservedWorkspacePath,
  producedFiles,
  type EvalWorkspaceEntry,
  type EvalWorkspaceSnapshot,
} from "./entry.js";

const sha = (c: string) => c.repeat(64);
const file = (path: string, size = 10, hash?: string): EvalWorkspaceEntry => ({
  path,
  type: "file",
  size,
  ...(hash === undefined ? {} : { sha256: sha(hash) }),
});
const walk = (entries: EvalWorkspaceEntry[], root = "", truncated = false) => ({
  root,
  entries,
  truncated,
});
const after = (...walks: ReturnType<typeof walk>[]): EvalWorkspaceSnapshot => ({ walks });

describe("what an outputs glob matches (KOBE-324 B1, S-R1, S-R2)", () => {
  it("reserves skills and hidden segments at any depth", () => {
    for (const p of [".kobe/sessions/x.jsonl", "skills/a/SKILL.md", "out/.cache/x", "a/skills/b"])
      expect(isReservedWorkspacePath(p), p).toBe(true);
    for (const p of ["outputs/q3.xlsx", "out/skills.csv", "notes.md"])
      expect(isReservedWorkspacePath(p), p).toBe(false);
  });

  it("walks only each glob's literal directory", () => {
    expect(evalOutputWalkRoot("outputs/*.xlsx")).toBe("outputs/");
    expect(evalOutputWalkRoot("out/a*/b.png")).toBe("out/");
    expect(evalOutputWalkRoot("outputs/report.pdf")).toBe("outputs/");
    expect(evalOutputWalkRoot("*.csv")).toBe("");
    expect(evalOutputWalkRoot("a\\*b/c*")).toBe("a*b/");
    expect(evalOutputWalkRoots(["outputs/*.xlsx", "outputs/x/*.png", "out/*"])).toEqual([
      "out/",
      "outputs/",
    ]);
    expect(evalOutputWalkRoots(["outputs/*", "*.md"])).toEqual([""]);
  });

  it("is not stopped by a big dependency tree outside the glob's directory", () => {
    const snapshot = after(walk([file("outputs/q3.xlsx")], "outputs/"));
    expect(checkEvalOutputs(["outputs/*.xlsx"], [], snapshot).passed).toBe(true);
    const truncated = after(walk([file("outputs/q3.xlsx")], "outputs/", true));
    expect(checkEvalOutputs(["outputs/*.xlsx"], [], truncated)).toMatchObject({
      reason: "over_cap",
      detail: `outputs/ holds more than ${EVAL_WORKSPACE_MAX_FILES} entries`,
    });
  });

  it("never lets a wildcard reach Kobe's or Pi's state", () => {
    const all = after(
      walk([
        file(".kobe/sessions/run.jsonl"),
        file("skills/report/SKILL.md"),
        file("out/.cache/x.jsonl"),
      ]),
    );
    for (const glob of ["*", "*.jsonl", "?kobe/*", "s*/x", "*/SKILL.md"])
      expect(checkEvalOutputs([glob], [], all), glob).toMatchObject({
        passed: false,
        reason: "not_produced",
      });
  });

  it("counts a new file without a hash, and a fixture only when its bytes changed", () => {
    const fixtures = [{ path: "outputs/q3.xlsx", sha256: sha("a") }];
    const unchanged = after(walk([file("outputs/q3.xlsx", 10, "a")], "outputs/"));
    expect(checkEvalOutputs(["outputs/*.xlsx"], fixtures, unchanged).reason).toBe("not_produced");
    const unhashed = after(walk([file("outputs/q3.xlsx")], "outputs/"));
    expect(checkEvalOutputs(["outputs/*.xlsx"], fixtures, unhashed).reason).toBe("not_produced");
    const edited = after(walk([file("outputs/q3.xlsx", 10, "c")], "outputs/"));
    expect(checkEvalOutputs(["outputs/*.xlsx"], fixtures, edited).passed).toBe(true);
    const created = after(
      walk([file("outputs/q3.xlsx", 10, "a"), file("outputs/q4.xlsx", 40 * 2 ** 20)], "outputs/"),
    );
    const result = checkEvalOutputs(["outputs/*.xlsx"], fixtures, created);
    expect(result.files.map((f) => f.path)).toEqual(["outputs/q4.xlsx"]);
  });

  it("never counts a link or another kind of entry, and never hashes a link", () => {
    const entries: EvalWorkspaceEntry[] = [
      { path: "outputs/x.xlsx", type: "symlink", size: 0 },
      { path: "outputs/y.xlsx", type: "other", size: 0 },
    ];
    expect(producedFiles([], walk(entries))).toEqual([]);
    expect(checkEvalOutputs(["outputs/*"], [], after(walk(entries))).passed).toBe(false);
    expect(
      evalWorkspaceEntrySchema.safeParse({ path: "../etc", type: "file", size: 1 }).success,
    ).toBe(false);
  });

  it("needs every glob matched and walked, and fails over the caps with a reason", () => {
    const snapshot = after(walk([file("out/a.png"), file("out/b.csv")], "out/"));
    expect(checkEvalOutputs(["out/*.png", "out/*.csv"], [], snapshot).passed).toBe(true);
    expect(checkEvalOutputs(["out/*.png", "out/*.pdf"], [], snapshot)).toMatchObject({
      passed: false,
      detail: "no produced file matches out/*.pdf",
    });
    expect(checkEvalOutputs(["outputs/*"], [], snapshot)).toMatchObject({
      reason: "not_produced",
      detail: "outputs/ was not walked",
    });
    const many = after(
      walk(Array.from({ length: EVAL_OUTPUT_MAX_MATCHES + 1 }, (_, i) => file(`out/${i}.png`))),
    );
    expect(checkEvalOutputs(["out/*"], [], many)).toMatchObject({ reason: "over_cap" });
    const big = after(walk([file("out/a.bin", 51 * 1024 * 1024)]));
    expect(checkEvalOutputs(["out/*"], [], big)).toMatchObject({ reason: "over_cap" });
  });
});

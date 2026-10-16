import { describe, expect, it } from "vitest";
import type { RunSkillRef } from "@kobe/db";
import { matchSkillRead, runSkillRefs, skillUsesFrom } from "./detect.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const refs: RunSkillRef[] = [
  { name: "pretty-html", source: "team", sha256: A },
  { name: "mine", source: "personal", sha256: B },
  { name: "pdf", source: "builtin" },
];
const read = (path: unknown, extra: Record<string, unknown> = {}) =>
  matchSkillRead("read", { path, ...extra }, refs);

describe("matchSkillRead (KOBE-297)", () => {
  it("names the run's bundle whose SKILL.md was read, by its hash directory", () => {
    expect(read(`/run/kobe-skills/store/sk-${A}/SKILL.md`)).toEqual(refs[0]);
    expect(read(`/run/kobe-skills/store/sk-${B}/SKILL.md`)).toEqual(refs[1]);
  });

  it("names a built-in the run lists by its image directory", () => {
    expect(read("/opt/kobe/skills/pdf/SKILL.md")).toEqual(refs[2]);
  });

  it("normalizes the path the tool reads (doubled slashes, dot segments)", () => {
    expect(read(`/run/kobe-skills//store/./sk-x/../sk-${A}/SKILL.md`)).toEqual(refs[0]);
  });

  it.each([
    ["another file of the skill", `/run/kobe-skills/store/sk-${A}/reference.md`],
    ["the skill directory itself", `/run/kobe-skills/store/sk-${A}`],
    ["a hash the run was not given (forged)", `/run/kobe-skills/store/sk-${C}/SKILL.md`],
    ["a built-in the run does not list", "/opt/kobe/skills/docx/SKILL.md"],
    ["a workspace SKILL.md", "/workspace/pretty-html/SKILL.md"],
    ["a workspace copy named like the store", `/workspace/run/kobe-skills/store/sk-${A}/SKILL.md`],
    ["a relative path", `run/kobe-skills/store/sk-${A}/SKILL.md`],
    [
      "a path climbing out of the store",
      `/run/kobe-skills/store/sk-${A}/../../../../workspace/SKILL.md`,
    ],
    ["a lower-case name", `/run/kobe-skills/store/sk-${A}/skill.md`],
    ["a NUL byte", `/run/kobe-skills/store/sk-${A}/SKILL.md\u0000`],
    ["an oversized path", `/run/kobe-skills/store/sk-${A}/SKILL.md`.padStart(5000, "/")],
    ["not a string", 42],
    ["no path at all", undefined],
  ])("counts nothing for %s", (_name, path) => {
    expect(read(path)).toBeUndefined();
  });

  it("ignores any label the sandbox sends with the call", () => {
    expect(read("/workspace/x/SKILL.md", { skill: "pretty-html", name: "pretty-html" })).toBe(
      undefined,
    );
  });

  it("counts only the read tool", () => {
    expect(matchSkillRead("bash", { path: `/run/kobe-skills/store/sk-${A}/SKILL.md` }, refs)).toBe(
      undefined,
    );
    expect(matchSkillRead("read", null, refs)).toBeUndefined();
  });

  it("counts nothing for a run that was given no skills", () => {
    expect(matchSkillRead("read", { path: `/run/kobe-skills/store/sk-${A}/SKILL.md` }, [])).toBe(
      undefined,
    );
  });
});

describe("runSkillRefs", () => {
  it("lists the bundles run.start carries, with their source, then the built-ins", () => {
    expect(
      runSkillRefs(
        [
          { name: "pretty-html", sha256: A, size: 10 },
          { name: "mine", sha256: B, size: 10 },
        ],
        [
          { name: "pretty-html", hash: A, source: "team" },
          { name: "mine", hash: B, source: "personal" },
          { name: "dropped", hash: C, source: "team" },
        ],
        ["pdf"],
      ),
    ).toEqual(refs);
  });

  it("drops a bundle whose source is unknown rather than guessing", () => {
    expect(runSkillRefs([{ name: "x", sha256: A, size: 1 }], [], [])).toEqual([]);
  });
});

describe("skillUsesFrom", () => {
  const call = (id: string, path: string) => ({
    type: "tool.call",
    payload: { tool_call_id: id, tool: "read", input: { path }, risk: "read" },
  });
  const result = (id: string, isError = false, tool = "read") => ({
    type: "tool.result",
    payload: { tool_call_id: id, tool, is_error: isError, preview: "", truncated: false },
  });
  const skill = `/run/kobe-skills/store/sk-${A}/SKILL.md`;

  it("counts a read whose result came back without error, once per tool call", () => {
    const { uses, unresolved } = skillUsesFrom(
      [call("t1", skill), result("t1"), call("t2", "/workspace/a.md"), result("t2"), result("t1")],
      refs,
    );
    expect(uses).toEqual([{ tool_call_id: "t1", name: "pretty-html", source: "team" }]);
    expect(unresolved).toEqual([]);
  });

  it("does not count a failed read, or a call whose result has not come yet", () => {
    expect(skillUsesFrom([call("t1", skill), result("t1", true)], refs).uses).toEqual([]);
    expect(skillUsesFrom([call("t2", skill)], refs).uses).toEqual([]);
  });

  it("asks for the input of a result whose call came in an earlier batch", () => {
    expect(skillUsesFrom([result("t9")], refs)).toEqual({ uses: [], unresolved: ["t9"] });
    expect(skillUsesFrom([result("t9", false, "bash")], refs).unresolved).toEqual([]);
  });

  it("does nothing for a run with no skills", () => {
    expect(skillUsesFrom([call("t1", skill), result("t1")], [])).toEqual({
      uses: [],
      unresolved: [],
    });
  });
});

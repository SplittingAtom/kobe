import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVAL_CASES_PATH,
  EVAL_MAX_CASES,
  EVAL_MAX_TURNS_DEFAULT,
  fixtureWorkspacePath,
  parseSkillEvalSuite,
  planSkillEvalExecutions,
  skillEvalCaseKind,
  skillEvalSuiteCounts,
  skillEvalSuiteSchema,
  type SkillEvalIssue,
} from "./entry.js";

const DIR = join(import.meta.dirname, "fixtures", "cases");
const read = (file: string) => readFileSync(join(DIR, file), "utf8");
const GOLDEN = JSON.parse(read("issues.json")) as Record<
  string,
  { code: string; path: string; line: number }[]
>;
/** The package the golden suites ship in. */
const PATHS = [
  "SKILL.md",
  EVAL_CASES_PATH,
  "evals/fixtures/sales.csv",
  "evals/fixtures/regions/map.json",
  "evals/fixtures/.pi/settings.json",
];
const shape = (issues: readonly SkillEvalIssue[]) =>
  issues.map(({ code, path, line }) => ({ code, path, line }));

describe("evals/cases.yaml golden fixtures (KOBE-324)", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".yaml"));

  it("has a golden issue list for every invalid fixture and none for a valid one", () => {
    const invalid = files.filter((f) => !f.startsWith("valid-")).sort();
    expect(Object.keys(GOLDEN).sort()).toEqual(invalid);
  });

  for (const file of files.filter((f) => f.startsWith("valid-")))
    it(`accepts ${file}`, () => {
      const result = parseSkillEvalSuite(read(file), { paths: PATHS });
      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
    });

  for (const [file, expected] of Object.entries(GOLDEN))
    it(`refuses ${file} with a precise issue`, () => {
      const result = parseSkillEvalSuite(read(file), { paths: PATHS });
      expect(result.ok).toBe(false);
      expect(shape(result.issues)).toEqual(expected);
      for (const issue of result.issues) {
        expect(issue.file).toBe(EVAL_CASES_PATH);
        expect(issue.column).toBeGreaterThanOrEqual(1);
        expect(issue.message).toMatch(/^[A-Za-z].*\.$/);
      }
    });
});

describe("parsing evals/cases.yaml", () => {
  it("reads the spec's example with defaults applied", () => {
    const result = parseSkillEvalSuite(read("valid-full.yaml"), { paths: PATHS });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const [q3, totals, unrelated] = result.suite.cases;
    expect(result.suite.model).toBe("smart");
    expect(q3).toMatchObject({
      id: "q3-workbook",
      files: ["fixtures/sales.csv"],
      expect: { triggers: true, outputs: ["outputs/*.xlsx"], max_cost_usd: 0.4, max_turns: 20 },
    });
    expect(totals?.expect.contains).toEqual(["Total"]);
    expect(totals?.expect.matches).toEqual([
      { pattern: "\\$[0-9,]+" },
      { pattern: "north|south", flags: "i" },
    ]);
    expect(totals?.expect.max_turns).toBe(8);
    expect(unrelated?.files).toEqual([]);
    expect(unrelated?.expect.max_turns).toBe(EVAL_MAX_TURNS_DEFAULT);
  });

  it("writes messages that name the place and say what to do", () => {
    const messages = (file: string) =>
      parseSkillEvalSuite(read(file), { paths: PATHS }).issues.map((i) => i.message);
    expect(messages("invalid-duplicate-id.yaml")).toEqual([
      "cases[1].id: q3 is already the id of cases[0]; each case needs its own id.",
    ]);
    expect(messages("invalid-unknown-expectation.yaml")).toEqual([
      "cases[0].expect.judge_model: unknown key. Kobe refuses what it does not know rather than skip a check.",
    ]);
    expect(messages("invalid-fixture-missing.yaml")).toEqual([
      "cases[0].files[1]: evals/fixtures/missing.csv is not in the skill.",
    ]);
    expect(messages("invalid-missing-prompt.yaml")).toEqual([
      "cases[0].prompt is missing: the message the eval sends, 1 to 8000 characters.",
    ]);
    expect(messages("invalid-regex.yaml")[0]).toMatch(
      /^cases\[0\]\.expect\.matches: not a regular expression \(.+\)\.$/,
    );
    expect(messages("invalid-too-many-cases.yaml")).toEqual([
      `cases: a suite has 1 to ${EVAL_MAX_CASES} cases.`,
    ]);
    expect(messages("invalid-api-version.yaml")).toEqual([
      "apiVersion: must be kobe.dev/skill-evals/v1 or left out; a newer format needs a newer Kobe.",
    ]);
  });

  it("gives the column of the offending node", () => {
    const [issue] = parseSkillEvalSuite(read("invalid-unknown-expectation.yaml")).issues;
    expect(issue).toMatchObject({ line: 6, column: 7 });
  });

  it("checks fixtures against the package only when the package's paths are given", () => {
    expect(parseSkillEvalSuite(read("invalid-fixture-missing.yaml")).ok).toBe(true);
    expect(parseSkillEvalSuite(read("invalid-fixture-missing.yaml"), { paths: PATHS }).ok).toBe(
      false,
    );
  });

  it("refuses a file over the size limit before parsing it", () => {
    const result = parseSkillEvalSuite(`cases: []\n#${"x".repeat(70 * 1024)}\n`);
    expect(shape(result.issues)).toEqual([{ code: "too_large", path: "", line: 1 }]);
  });

  it("reports every problem at once, in file order", () => {
    const text = [
      "model: Bad Alias",
      "cases:",
      "  - id: a",
      "    prompt: x",
      "    expect: { max_turns: 500, triggers: yes }",
      "  - id: a",
      "    prompt: ''",
      "    expect: { judge: ok }",
    ].join("\n");
    expect(shape(parseSkillEvalSuite(text).issues)).toEqual([
      { code: "invalid_value", path: "model", line: 1 },
      { code: "out_of_range", path: "cases[0].expect.max_turns", line: 5 },
      { code: "invalid_type", path: "cases[0].expect.triggers", line: 5 },
      { code: "duplicate", path: "cases[1].id", line: 6 },
      { code: "out_of_range", path: "cases[1].prompt", line: 7 },
    ]);
  });

  it("refuses explicit tags of every kind, and deep nesting in any form", () => {
    const codes = (text: string) => parseSkillEvalSuite(text).issues.map((i) => i.code);
    const one = (value: string) =>
      `cases:\n  - id: a\n    prompt: p\n    expect: { triggers: true, contains: ${value} }\n`;
    expect(codes(one("!!timestamp 2020-01-01"))).toEqual(["yaml_tag"]);
    expect(codes(one("!!str x"))).toEqual(["yaml_tag"]);
    expect(codes(one("x"))).toEqual([]);
    expect(codes(`a: ${"[".repeat(5000)}${"]".repeat(5000)}\n`)).toEqual(["too_deep"]);
    const block = Array.from({ length: 20 }, (_, i) => `${" ".repeat(i)}k:`).join("\n");
    expect(codes(`${block}\n${" ".repeat(20)}v: 1\n`)).toEqual(["too_deep"]);
  });

  it("takes the Site's lower case limit, so lint agrees with the runner", () => {
    const result = parseSkillEvalSuite(read("valid-full.yaml"), { maxCases: 2 });
    expect(shape(result.issues)).toEqual([{ code: "out_of_range", path: "cases", line: 5 }]);
    expect(result.issues[0]?.message).toBe("cases: this Site runs at most 2 cases per suite.");
  });

  it("keeps contains exactly as written and refuses engine-specific regex syntax", () => {
    const suite = (expect_: object) =>
      skillEvalSuiteSchema.safeParse({ cases: [{ id: "a", prompt: "x", expect: expect_ }] });
    expect(suite({ contains: "  Total  " }).data?.cases[0]?.expect.contains).toEqual(["  Total  "]);
    expect(suite({ matches: "(?i:total)" }).success).toBe(false);
    expect(suite({ matches: "(?<year>\\d{4})" }).success).toBe(true);
  });

  it("refuses controls in prompts, bad flags, escaping and duplicate globs", () => {
    const suite = (expect_: object, extra: object = {}) =>
      skillEvalSuiteSchema.safeParse({
        cases: [{ id: "a", prompt: "x", expect: expect_, ...extra }],
      }).success;
    expect(suite({ triggers: true })).toBe(true);
    expect(suite({ triggers: true }, { prompt: "a\u0000b" })).toBe(false);
    expect(suite({ triggers: true }, { prompt: "line one\nline two\ttab" })).toBe(true);
    expect(suite({ matches: [{ pattern: "a", flags: "g" }] })).toBe(false);
    expect(suite({ matches: [{ pattern: "a", flags: "ii" }] })).toBe(false);
    expect(suite({ matches: [{ pattern: "a", flags: "ims" }] })).toBe(true);
    expect(suite({ outputs: ["../x"] })).toBe(false);
    expect(suite({ outputs: ["out/*.png", "out/*.png"] })).toBe(false);
    expect(suite({ outputs: ["skills/x/*"] })).toBe(false);
    expect(suite({ outputs: [".kobe/*"] })).toBe(false);
    expect(suite({ outputs: ["*"] })).toBe(true);
    expect(suite({ contains: "" })).toBe(false);
    expect(suite({ triggers: true, max_cost_usd: 0 })).toBe(false);
    expect(suite({ triggers: true, max_cost_usd: 50 })).toBe(true);
    expect(suite({ triggers: true }, { files: ["fixtures/a", "fixtures/a"] })).toBe(false);
    expect(suite({ triggers: true }, { files: ["fixtures/../SKILL.md"] })).toBe(false);
  });
});

describe("case kinds and the executions a run makes", () => {
  const result = parseSkillEvalSuite(read("valid-full.yaml"));
  if (!result.ok) throw new Error("fixture");
  const suite = result.suite;

  it("classifies trigger and behaviour cases", () => {
    expect(suite.cases.map(skillEvalCaseKind)).toEqual([
      "behaviour",
      "behaviour",
      "negative_trigger",
    ]);
    expect(
      skillEvalCaseKind({
        id: "t",
        prompt: "p",
        files: [],
        expect: { triggers: true, max_turns: 20 },
      }),
    ).toBe("positive_trigger");
    expect(skillEvalSuiteCounts(suite)).toEqual({
      cases: 3,
      positiveTriggerCases: 0,
      casesExpectingTrigger: 1,
      negativeTriggerCases: 1,
      behaviourCases: 2,
      baselineCases: 2,
    });
  });

  it("runs a baseline only for behaviour cases that may trigger; negatives run with the skill only", () => {
    expect(planSkillEvalExecutions(suite, "full")).toEqual([
      { caseId: "q3-workbook", withSkill: true },
      { caseId: "q3-workbook", withSkill: false },
      { caseId: "totals-in-answer", withSkill: true },
      { caseId: "totals-in-answer", withSkill: false },
      { caseId: "unrelated-question", withSkill: true },
    ]);
    expect(planSkillEvalExecutions(suite, "with_only")).toEqual([
      { caseId: "q3-workbook", withSkill: true },
      { caseId: "totals-in-answer", withSkill: true },
      { caseId: "unrelated-question", withSkill: true },
    ]);
  });

  it("places fixtures at their path below fixtures/ in /workspace", () => {
    expect(fixtureWorkspacePath("fixtures/sales.csv")).toBe("sales.csv");
    expect(fixtureWorkspacePath("fixtures/regions/map.json")).toBe("regions/map.json");
  });
});

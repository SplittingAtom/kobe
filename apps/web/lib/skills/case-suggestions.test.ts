import { parseSkillEvalSuite } from "@kobe/protocol/skill-evals";
import { describe, expect, it } from "vitest";
import { appendCases, caseIdsOf, suggestTriggerCases } from "./case-suggestions";

/** KOBE-328 ac-2: suggestions always hold a negative trigger case, and make a valid suite. */
describe("case suggestions", () => {
  it("proposes positives from the description's requests and at least one negative case", () => {
    const cases = suggestTriggerCases({
      name: "sales-report",
      description:
        "Builds the monthly sales workbook. Use when asked for a sales report, a revenue summary or a regional breakdown.",
    });
    const positives = cases.filter((c) => c.triggers);
    const negatives = cases.filter((c) => !c.triggers);
    expect(positives.map((c) => c.prompt)).toEqual([
      "Please help: a sales report.",
      "Please help: a revenue summary.",
      "Please help: a regional breakdown.",
    ]);
    expect(negatives.length).toBeGreaterThanOrEqual(1);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("still proposes a negative case when the description names no requests", () => {
    const cases = suggestTriggerCases({ name: "house-style", description: "Our writing rules." });
    expect(cases.some((c) => !c.triggers)).toBe(true);
    expect(cases.some((c) => c.triggers)).toBe(true);
  });

  it("keeps ids unique against the cases already there", () => {
    const cases = suggestTriggerCases({ name: "x", description: "", taken: ["unrelated"] });
    expect(cases.map((c) => c.id)).toContain("unrelated-2");
    expect(cases.map((c) => c.id)).not.toContain("unrelated");
  });

  it("appends to an existing suite (keeping its comments) or starts one; the result parses", () => {
    const existing =
      "# our suite\ncases:\n  - id: totals\n    prompt: Sum it\n    expect: {contains: Total}\n";
    const suggestions = suggestTriggerCases({
      name: "report",
      description: "Use when asked for a report.",
      taken: caseIdsOf(existing),
    });
    const text = appendCases(existing, suggestions);
    expect(text).toContain("# our suite");
    const parsed = parseSkillEvalSuite(text ?? "");
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.suite.cases[0]?.id).toBe("totals");
    expect(parsed.suite.cases.some((c) => c.expect.triggers === false)).toBe(true);
    const fresh = appendCases(undefined, suggestions);
    expect(parseSkillEvalSuite(fresh ?? "").ok).toBe(true);
    expect(appendCases("- just a list\n", suggestions)).toBeNull();
  });
});

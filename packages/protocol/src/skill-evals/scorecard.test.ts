import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { provenanceSchema } from "../skill-package/provenance.js";
import {
  catalogSkillEvalScorecardSchema,
  computeSkillEvalScorecard,
  expectedChecks,
  parseSkillEvalSuite,
  scorecardForProvenance,
  SKILL_EVAL_SUBMISSION_DEFAULTS,
  SkillEvalScorecardError,
  skillEvalScorecardSchema,
  skillEvalSubmissionRulesSchema,
  skillEvalSubmissionShortfalls,
  verifySkillEvalScorecard,
  type SkillEvalExecution,
  type SkillEvalScorecard,
} from "./entry.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const readJson = (file: string) =>
  JSON.parse(readFileSync(join(FIXTURES, "scorecard", file), "utf8")) as SkillEvalScorecard;
const GOLDEN = readJson("valid-full.json");
const parsed = parseSkillEvalSuite(
  readFileSync(join(FIXTURES, "cases", "valid-full.yaml"), "utf8"),
);
if (!parsed.ok) throw new Error("fixture");
const SUITE = parsed.suite;
const AT = "2026-10-18T10:00:00.000Z";

const executions = (card: SkillEvalScorecard): SkillEvalExecution[] =>
  card.details.flatMap((d) => (d.without ? [d.with, d.without] : [d.with]));
const input = (card: SkillEvalScorecard, overrides: object = {}) => ({
  suite: SUITE,
  mode: card.mode,
  packageHash: card.packageHash,
  runModel: card.runModel,
  judgeModel: card.judgeModel,
  executions: executions(card),
  startedAt: card.startedAt,
  completedAt: card.completedAt,
  ...overrides,
});
const clone = <T>(x: T): T => structuredClone(x);
const fail = (e: SkillEvalExecution, check: SkillEvalExecution["checks"][number]["check"]) => {
  e.status = "failed";
  e.checks = e.checks.map((c) =>
    c.check === check ? { check, passed: false, reason: "not_triggered" as const } : c,
  );
};

describe("the scorecard (KOBE-324)", () => {
  it("accepts the golden scorecard and computes it exactly from its executions", () => {
    expect(skillEvalScorecardSchema.parse(GOLDEN)).toEqual(GOLDEN);
    expect(computeSkillEvalScorecard(input(GOLDEN))).toEqual(GOLDEN);
    expect(verifySkillEvalScorecard(GOLDEN, SUITE)).toMatchObject({ ok: true });
  });

  it("reports a missing run model alias on every case (KOBE-326, SK17)", () => {
    const card = clone(GOLDEN);
    const fellBack = { requested: "huge", used: "smart", fellBack: true };
    const marked = executions(card).map((e) => ({ ...e, requestedModel: "huge" }));
    const out = computeSkillEvalScorecard(input(card, { runModel: fellBack, executions: marked }));
    expect(out.runModel).toEqual(fellBack);
    for (const e of executions(out))
      expect(e).toMatchObject({ model: "smart", requestedModel: "huge" });
    // A fallback no case reports, a case that reports one the card hasn't, or another model: refused.
    expect(() => computeSkillEvalScorecard(input(card, { runModel: fellBack }))).toThrow(
      /reports the card's run model/,
    );
    expect(() => computeSkillEvalScorecard(input(card, { executions: marked }))).toThrow(
      /reports the card's run model/,
    );
    const other = executions(card).map((e) => ({ ...e, model: "fast" }));
    expect(() => computeSkillEvalScorecard(input(card, { executions: other }))).toThrow(
      /reports the card's run model/,
    );
  });

  it("computes lift over the cases that ran in both modes", () => {
    const card = clone(GOLDEN);
    const q3 = card.details[0];
    if (!q3?.without) throw new Error("fixture");
    q3.without.status = "passed";
    q3.without.checks = [
      { check: "outputs", passed: true },
      { check: "judge", passed: true },
      { check: "max_cost_usd", passed: true },
      { check: "max_turns", passed: true },
    ];
    const out = computeSkillEvalScorecard(input(card));
    expect(out).toMatchObject({ baselinePassRate: 0.5, lift: 0.5, passRate: 1 });
  });

  it("gives no lift, with a reason, when a baseline errored: never the best lift", () => {
    const card = clone(GOLDEN);
    for (const d of card.details)
      if (d.without)
        d.without = { ...d.without, status: "error", triggered: null, checks: [], threadId: null };
    const out = computeSkillEvalScorecard(input(card));
    expect(out).toMatchObject({ lift: null, liftUnavailable: "incomplete_pairs" });
    expect(out.without).toMatchObject({ executions: 2, errored: 2, passed: 0 });
    expect(skillEvalSubmissionShortfalls(scorecardForProvenance(out, AT), out.packageHash)).toEqual(
      ["lift"],
    );
  });

  it("defines trigger precision and recall, with the counts behind them", () => {
    const card = clone(GOLDEN);
    const [q3, , unrelated] = card.details;
    if (!q3 || !unrelated) throw new Error("fixture");
    unrelated.with.skillUses = 2;
    unrelated.with.triggered = true;
    unrelated.with.status = "failed";
    unrelated.with.checks[0] = { check: "triggers", passed: false, reason: "unexpected_trigger" };
    let out = computeSkillEvalScorecard(input(card));
    expect(out).toMatchObject({ triggerPrecision: 0.5, triggerRecall: 1 });
    expect(out.triggerCounts).toEqual({ observed: 2, tp: 1, fp: 1, fn: 0, tn: 0 });
    q3.with.skillUses = 0;
    q3.with.triggered = false;
    fail(q3.with, "triggers");
    out = computeSkillEvalScorecard(input(card));
    expect(out).toMatchObject({ triggerPrecision: 0, triggerRecall: 0 });
    expect(out.passRate).toBeCloseTo(1 / 3);
  });

  it("leaves precision null when the skill was never read, and that fails SK20", () => {
    const card = clone(GOLDEN);
    const q3 = card.details[0];
    if (!q3) throw new Error("fixture");
    q3.with.skillUses = 0;
    q3.with.triggered = false;
    fail(q3.with, "triggers");
    const out = computeSkillEvalScorecard(input(card));
    expect(out).toMatchObject({ triggerPrecision: null, triggerRecall: 0 });
    const catalog = scorecardForProvenance(out, AT);
    expect(catalog).not.toHaveProperty("triggerPrecision");
    expect(skillEvalSubmissionShortfalls(catalog, out.packageHash)).toContain("trigger_precision");
  });

  it("keeps an errored execution out of the trigger numbers but counts it as failed", () => {
    const card = clone(GOLDEN);
    const unrelated = card.details[2];
    if (!unrelated) throw new Error("fixture");
    unrelated.with = {
      ...unrelated.with,
      status: "error",
      triggered: null,
      checks: [],
      threadId: null,
      runId: null,
    };
    const out = computeSkillEvalScorecard(input(card));
    expect(out.passRate).toBeCloseTo(2 / 3);
    expect(out.with).toMatchObject({ passed: 2, errored: 1 });
    expect(out.triggerCounts).toEqual({ observed: 1, tp: 1, fp: 0, fn: 0, tn: 0 });
  });

  it("has no baseline or lift in a with_only run, and never exports one", () => {
    const execs = executions(GOLDEN).filter((e) => e.withSkill);
    const out = computeSkillEvalScorecard(input(GOLDEN, { mode: "with_only", executions: execs }));
    expect(out).toMatchObject({
      mode: "with_only",
      baselinePassRate: null,
      lift: null,
      liftUnavailable: "with_only",
      without: null,
      costUsd: 0.57,
      judgeCostUsd: 0.01,
    });
    expect(out.details.every((d) => d.without === null)).toBe(true);
    expect(() => scorecardForProvenance(out, AT)).toThrow(SkillEvalScorecardError);
  });

  it("refuses executions that do not match the plan or their case", () => {
    const all = executions(GOLDEN);
    const run = (execs: unknown[]) =>
      computeSkillEvalScorecard(input(GOLDEN, { executions: execs }));
    expect(() => run(all.slice(1))).toThrow(SkillEvalScorecardError);
    expect(() => run([...all, all[0]])).toThrow(/twice/);
    expect(() =>
      run([
        ...all,
        {
          ...all[4],
          withSkill: false,
          triggered: null,
          status: "failed",
          checks: [{ check: "max_turns", passed: false, reason: "over_limit" }],
        },
      ]),
    ).toThrow(/not planned/);
    const q3 = clone(all[0]) as SkillEvalExecution;
    q3.checks = q3.checks.filter((c) => c.check !== "judge");
    expect(() => run([q3, ...all.slice(1)])).toThrow(/passed without judge/);
  });

  it("lists the checks each execution must make", () => {
    const [q3, totals, unrelated] = SUITE.cases;
    if (!q3 || !totals || !unrelated) throw new Error("fixture");
    expect(expectedChecks(q3, true)).toEqual([
      "triggers",
      "outputs",
      "judge",
      "max_cost_usd",
      "max_turns",
    ]);
    expect(expectedChecks(q3, false)).toEqual(["outputs", "judge", "max_cost_usd", "max_turns"]);
    expect(expectedChecks(totals, true)).toEqual([
      "contains",
      "matches",
      "max_turns",
      "no_denied_tools",
    ]);
    expect(expectedChecks(unrelated, true)).toEqual(["triggers", "max_turns"]);
  });

  describe("forged scorecards fail verification", () => {
    const forged = readdirSync(join(FIXTURES, "scorecard")).filter((f) => f.startsWith("forged-"));
    it("has forged fixtures", () => expect(forged.length).toBeGreaterThanOrEqual(10));
    for (const file of forged)
      it(file, () => {
        const result = verifySkillEvalScorecard(readJson(file), SUITE);
        expect(result.ok).toBe(false);
      });

    it("fails when the stored execution rows differ from the card's details", () => {
      const rows = executions(GOLDEN).map((e) => ({ ...e }));
      const first = rows[0];
      if (!first) throw new Error("fixture");
      first.status = "failed";
      first.checks = first.checks.map((c) =>
        c.check === "outputs" ? { check: "outputs", passed: false, reason: "not_produced" } : c,
      );
      expect(verifySkillEvalScorecard(GOLDEN, SUITE, rows)).toMatchObject({ ok: false });
    });
  });

  it("refuses inconsistent executions", () => {
    const bad = (mutate: (card: SkillEvalScorecard) => void) => {
      const card = clone(GOLDEN);
      mutate(card);
      return skillEvalScorecardSchema.safeParse(card).success;
    };
    const q3 = (c: SkillEvalScorecard) => c.details[0]?.with as SkillEvalExecution;
    expect(bad(() => undefined)).toBe(true);
    expect(bad((c) => (q3(c).checks[1] = { check: "outputs", passed: false }))).toBe(false);
    expect(bad((c) => ((c.details[2]?.with as SkillEvalExecution).status = "failed"))).toBe(false);
    expect(bad((c) => ((c.details[0]?.without as SkillEvalExecution).triggered = false))).toBe(
      false,
    );
    expect(bad((c) => ((c.details[0]?.without as SkillEvalExecution).skillUses = 1))).toBe(false);
    expect(bad((c) => (q3(c).status = "cancelled" as "error"))).toBe(false);
    expect(bad((c) => (q3(c).checks = [...q3(c).checks].reverse()))).toBe(false);
    expect(bad((c) => (q3(c).attempts = 3 as 1))).toBe(false);
    expect(bad((c) => (c.mode = "with_only"))).toBe(false);
    expect(bad((c) => (c.liftUnavailable = "no_baseline_cases"))).toBe(false);
    expect(bad((c) => ((c as unknown as Record<string, unknown>).transcript = "…"))).toBe(false);
  });
});

describe("what leaves the team (SK16, SK19, SK20)", () => {
  it("projects numbers only into the catalog scorecard", () => {
    const out = scorecardForProvenance(GOLDEN, AT);
    expect(out).toEqual({
      packageHash: GOLDEN.packageHash,
      mode: "full",
      cases: 3,
      negativeTriggerCases: 1,
      baselineCases: 2,
      passRateWith: 1,
      passRateWithout: 0,
      lift: 1,
      triggerPrecision: 1,
      triggerRecall: 1,
      triggerCounts: { observed: 2, tp: 1, fp: 0, fn: 0, tn: 1 },
      executions: {
        with: { executions: 3, passed: 3, failed: 0, errored: 0, timedOut: 0 },
        without: { executions: 2, passed: 0, failed: 2, errored: 0, timedOut: 0 },
      },
      costUsd: 0.83,
      judge: { source: "site" },
      runModelFellBack: false,
      at: AT,
    });
    const text = JSON.stringify(out);
    for (const secret of ["threadId", "runId", "detail", "q3-workbook", "workbook", "smart"])
      expect(text).not.toContain(secret);
  });

  it("refuses a catalog scorecard whose rates disagree with its counts", () => {
    const card = scorecardForProvenance(GOLDEN, AT);
    const ok = (patch: object) =>
      catalogSkillEvalScorecardSchema.safeParse({ ...card, ...patch }).success;
    expect(ok({})).toBe(true);
    expect(ok({ passRateWith: 0.5 })).toBe(false);
    expect(ok({ triggerPrecision: 0.5 })).toBe(false);
    expect(ok({ triggerCounts: { observed: 2, tp: 1, fp: 1, fn: 0, tn: 0 } })).toBe(false);
    expect(ok({ lift: undefined })).toBe(false);
    expect(ok({ mode: "with_only" })).toBe(false);
    expect(ok({ details: [] })).toBe(false);
  });

  it("is a valid provenance scorecard", () => {
    const base = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../skill-package/fixtures/provenance/valid-full.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const withScore = { ...base, scorecard: scorecardForProvenance(GOLDEN, AT) };
    expect(provenanceSchema.safeParse(withScore).success).toBe(true);
  });

  it("checks the SK20 eval rules, a missing number failing its rule", () => {
    const card = scorecardForProvenance(GOLDEN, AT);
    expect(skillEvalSubmissionShortfalls(card, GOLDEN.packageHash)).toEqual([]);
    expect(skillEvalSubmissionShortfalls(card, "0".repeat(64))).toEqual(["stale"]);
    expect(
      skillEvalSubmissionShortfalls(card, GOLDEN.packageHash, {
        ...SKILL_EVAL_SUBMISSION_DEFAULTS,
        minCases: 4,
      }),
    ).toEqual(["too_few_cases"]);
    expect(skillEvalSubmissionRulesSchema.parse({})).toEqual(SKILL_EVAL_SUBMISSION_DEFAULTS);
    expect(skillEvalSubmissionRulesSchema.safeParse({ minPassRate: 1.5 }).success).toBe(false);
    expect(skillEvalSubmissionRulesSchema.safeParse({ minCases: -1 }).success).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { provenanceSchema } from "../skill-package/provenance.js";
import {
  computeSkillEvalScorecard,
  parseSkillEvalSuite,
  scorecardForProvenance,
  SkillEvalScorecardError,
  skillEvalScorecardSchema,
  type SkillEvalExecution,
  type SkillEvalScorecard,
} from "./index.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const GOLDEN = JSON.parse(
  readFileSync(join(FIXTURES, "scorecard", "valid-full.json"), "utf8"),
) as SkillEvalScorecard;
const parsed = parseSkillEvalSuite(
  readFileSync(join(FIXTURES, "cases", "valid-full.yaml"), "utf8"),
);
if (!parsed.ok) throw new Error("fixture");
const SUITE = parsed.suite;

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

describe("the scorecard (KOBE-324)", () => {
  it("accepts the golden scorecard", () => {
    expect(skillEvalScorecardSchema.parse(GOLDEN)).toEqual(GOLDEN);
  });

  it("computes the golden scorecard from the suite and its executions", () => {
    expect(computeSkillEvalScorecard(input(GOLDEN))).toEqual(GOLDEN);
  });

  it("computes lift over the cases that ran in both modes", () => {
    const card = clone(GOLDEN);
    const q3 = card.details[0];
    if (!q3?.without) throw new Error("fixture");
    q3.without.status = "passed";
    q3.without.checks = q3.without.checks.map((c) => ({ check: c.check, passed: true }));
    const out = computeSkillEvalScorecard(input(card));
    expect(out.baselinePassRate).toBe(0.5);
    expect(out.lift).toBe(0.5);
    expect(out.passRate).toBe(1);
  });

  it("defines trigger precision and recall over cases that expect a trigger either way", () => {
    const card = clone(GOLDEN);
    const [q3, , unrelated] = card.details;
    if (!q3 || !unrelated) throw new Error("fixture");
    unrelated.with.triggered = true;
    unrelated.with.status = "failed";
    unrelated.with.checks[0] = { check: "triggers", passed: false };
    let out = computeSkillEvalScorecard(input(card));
    expect(out.triggerPrecision).toBe(0.5);
    expect(out.triggerRecall).toBe(1);
    q3.with.triggered = false;
    q3.with.status = "failed";
    q3.with.checks[0] = { check: "triggers", passed: false };
    out = computeSkillEvalScorecard(input(card));
    expect(out.triggerPrecision).toBe(0);
    expect(out.triggerRecall).toBe(0);
    expect(out.passRate).toBeCloseTo(1 / 3);
  });

  it("leaves precision out when nothing triggered, and both out without trigger cases", () => {
    const card = clone(GOLDEN);
    const q3 = card.details[0];
    if (!q3) throw new Error("fixture");
    q3.with.triggered = false;
    q3.with.status = "failed";
    q3.with.checks[0] = { check: "triggers", passed: false };
    const out = computeSkillEvalScorecard(input(card));
    expect(out.triggerPrecision).toBeNull();
    expect(out.triggerRecall).toBe(0);
  });

  it("keeps an execution with no observation out of the trigger numbers but counts it as failed", () => {
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
    expect(out.triggerPrecision).toBe(1);
  });

  it("has no baseline or lift in a with_only run", () => {
    const card = clone(GOLDEN);
    const execs = executions(card).filter((e) => e.withSkill);
    const out = computeSkillEvalScorecard(input(card, { mode: "with_only", executions: execs }));
    expect(out).toMatchObject({
      mode: "with_only",
      baselinePassRate: null,
      lift: null,
      without: null,
      costUsd: 0.57,
      judgeCostUsd: 0.01,
    });
    expect(out.details.every((d) => d.without === null)).toBe(true);
    expect(skillEvalScorecardSchema.safeParse(out).success).toBe(true);
  });

  it("refuses executions that do not match the plan", () => {
    const all = executions(GOLDEN);
    expect(() => computeSkillEvalScorecard(input(GOLDEN, { executions: all.slice(1) }))).toThrow(
      SkillEvalScorecardError,
    );
    expect(() =>
      computeSkillEvalScorecard(input(GOLDEN, { executions: [...all, all[0]] })),
    ).toThrow(/twice/);
    const baselineNegative = {
      ...all[4],
      withSkill: false,
      triggered: null,
      status: "failed",
      checks: [{ check: "max_turns", passed: false }],
    };
    expect(() =>
      computeSkillEvalScorecard(input(GOLDEN, { executions: [...all, baselineNegative] })),
    ).toThrow(/not planned/);
  });

  it("refuses inconsistent scorecards", () => {
    const bad = (mutate: (card: SkillEvalScorecard) => void) => {
      const card = clone(GOLDEN);
      mutate(card);
      return skillEvalScorecardSchema.safeParse(card).success;
    };
    expect(bad(() => undefined)).toBe(true);
    // passed with a failed check
    expect(
      bad((c) => {
        const e = c.details[0]?.with;
        if (e) e.checks[1] = { check: "outputs", passed: false };
      }),
    ).toBe(false);
    // failed with every check passing
    expect(
      bad((c) => {
        const e = c.details[2]?.with;
        if (e) e.status = "failed";
      }),
    ).toBe(false);
    // a baseline that "triggered" or checks triggers
    expect(
      bad((c) => {
        const e = c.details[0]?.without;
        if (e) e.triggered = false;
      }),
    ).toBe(false);
    expect(
      bad((c) => {
        const e = c.details[0]?.without;
        if (e) e.checks.push({ check: "triggers", passed: true });
      }),
    ).toBe(false);
    // a with_only scorecard with a baseline
    expect(
      bad((c) => {
        c.mode = "with_only";
      }),
    ).toBe(false);
    expect(
      bad((c) => {
        c.passRate = 1.5;
      }),
    ).toBe(false);
    expect(
      bad((c) => {
        (c as unknown as Record<string, unknown>).transcript = "…";
      }),
    ).toBe(false);
    expect(
      bad((c) => {
        const e = c.details[0]?.with;
        if (e) e.attempts = 3 as 1;
      }),
    ).toBe(false);
    expect(
      bad((c) => {
        const e = c.details[0]?.with;
        if (e) e.checks[2] = { check: "judge", passed: true, detail: "x".repeat(1001) };
      }),
    ).toBe(false);
  });
});

describe("what leaves the team (SK16, SK19)", () => {
  it("projects numbers only into provenance.json", () => {
    const at = "2026-10-18T10:00:00.000Z";
    const out = scorecardForProvenance(GOLDEN, at);
    expect(out).toEqual({
      packageHash: GOLDEN.packageHash,
      mode: "full",
      cases: 3,
      negativeTriggerCases: 1,
      passRateWith: 1,
      passRateWithout: 0,
      lift: 1,
      triggerPrecision: 1,
      triggerRecall: 1,
      costUsd: 0.84,
      at,
    });
    const text = JSON.stringify(out);
    for (const secret of ["threadId", "runId", "detail", "q3-workbook", "workbook", "smart"])
      expect(text).not.toContain(secret);
  });

  it("is a valid provenance scorecard, also without trigger numbers", () => {
    const base = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../skill-package/fixtures/provenance/valid-full.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const at = "2026-10-18T10:00:00.000Z";
    const withScore = { ...base, scorecard: scorecardForProvenance(GOLDEN, at) };
    expect(provenanceSchema.safeParse(withScore).success).toBe(true);
    const noTriggers = scorecardForProvenance(
      { ...GOLDEN, triggerPrecision: null, triggerRecall: null },
      at,
    );
    expect(noTriggers).not.toHaveProperty("triggerPrecision");
    expect(provenanceSchema.safeParse({ ...base, scorecard: noTriggers }).success).toBe(true);
  });
});

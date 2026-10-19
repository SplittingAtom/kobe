import { z } from "zod";
import { SHA256_HEX_PATTERN } from "../skill-package/layout.js";

/**
 * The scorecard that may cross the team wall (KOBE-324, spec SK19, SK20, SK23): aggregates only.
 * **Only this type may be written to a site-wide table** (`registry_versions.scorecard`,
 * `authoritative_scorecard`), **an event outside the team, an export or `provenance.json`.** The
 * team's `SkillEvalScorecard` (case ids, check details, judge reasons, thread and run ids) never
 * may; `scorecardForProvenance` is the one way from it to this.
 *
 * Counts, not content: the status counts behind each pass rate and the confusion counts behind
 * trigger precision and recall, so "1.0 over one case" and "1.0 over ten" read differently. The
 * schema checks that every rate equals its counts. `full` runs only (SK16: submissions always use
 * a full run).
 */

const ratio = z.number().min(0).max(1);
const count = z.number().int().min(0);
/** ISO 8601 instant in UTC with milliseconds, as `Date.prototype.toISOString` writes it. */
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((s) => new Date(s).toISOString() === s, "an instant as toISOString writes it");

/** Why a scorecard has no lift. */
export const SKILL_EVAL_LIFT_UNAVAILABLE = [
  /** A `with_only` run (team scorecards only; never a catalog one). */
  "with_only",
  /** No behaviour case, so nothing ran without the skill. */
  "no_baseline_cases",
  /** An execution of a baseline pair errored: an infrastructure failure is no evidence. */
  "incomplete_pairs",
] as const;
export type SkillEvalLiftUnavailable = (typeof SKILL_EVAL_LIFT_UNAVAILABLE)[number];

export const skillEvalStatusCountsSchema = z
  .strictObject({
    executions: z.number().int().min(1),
    passed: count,
    failed: count,
    errored: count,
    timedOut: count,
  })
  .refine(
    (c) => c.passed + c.failed + c.errored + c.timedOut === c.executions,
    "the statuses add up to the executions",
  );
export type SkillEvalStatusCounts = z.infer<typeof skillEvalStatusCountsSchema>;

/**
 * Over with-skill executions of cases that set `triggers` and observed whether the skill was read
 * (an errored execution observes nothing). tp: expected and read; fp: not expected, read; fn:
 * expected, not read; tn: not expected, not read.
 */
export const skillEvalTriggerCountsSchema = z
  .strictObject({ observed: count, tp: count, fp: count, fn: count, tn: count })
  .refine((t) => t.tp + t.fp + t.fn + t.tn === t.observed, "the counts add up to observed");
export type SkillEvalTriggerCounts = z.infer<typeof skillEvalTriggerCountsSchema>;

const rateOf = (num: number, den: number) => (den === 0 ? undefined : num / den);

export const catalogSkillEvalScorecardSchema = z
  .strictObject({
    packageHash: z.string().regex(SHA256_HEX_PATTERN),
    mode: z.literal("full"),
    cases: z.number().int().min(1),
    negativeTriggerCases: count,
    /** Behaviour cases: those that also ran without the skill. */
    baselineCases: count,
    passRateWith: ratio,
    /** Absent when no case ran without the skill. */
    passRateWithout: ratio.optional(),
    lift: z.number().min(-1).max(1).optional(),
    /** Set exactly when `lift` is absent. */
    liftUnavailable: z.enum(SKILL_EVAL_LIFT_UNAVAILABLE).optional(),
    /** Absent when the denominator is 0; an absent precision fails SK20's precision rule. */
    triggerPrecision: ratio.optional(),
    triggerRecall: ratio.optional(),
    triggerCounts: skillEvalTriggerCountsSchema,
    executions: z.strictObject({
      with: skillEvalStatusCountsSchema,
      without: skillEvalStatusCountsSchema.optional(),
    }),
    /** All eval spend of the run, judge included. */
    costUsd: z.number().min(0).max(1_000_000),
    /** The judge's source (SK17), absent when no case has a rubric: a team judge reads apart. */
    judge: z.strictObject({ source: z.enum(["site", "team"]) }).optional(),
    /** The suite's model wasn't enabled in the team, so its default ran (SK17). */
    runModelFellBack: z.boolean(),
    at: instant,
  })
  .superRefine((s, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const { with: w, without } = s.executions;
    const t = s.triggerCounts;
    if (w.executions !== s.cases) fail("one with-skill execution per case");
    if (s.passRateWith !== w.passed / w.executions) fail("passRateWith is passed / executions");
    if ((without?.executions ?? 0) !== s.baselineCases) fail("one baseline per baseline case");
    if (s.passRateWithout !== (without ? without.passed / without.executions : undefined))
      fail("passRateWithout is passed / executions without the skill");
    if ((s.lift === undefined) === (s.liftUnavailable === undefined))
      fail("lift or the reason it is unavailable");
    if (s.liftUnavailable === "with_only") fail("a catalog scorecard is from a full run");
    if (s.triggerPrecision !== rateOf(t.tp, t.tp + t.fp))
      fail("triggerPrecision is tp / (tp + fp)");
    if (s.triggerRecall !== rateOf(t.tp, t.tp + t.fn)) fail("triggerRecall is tp / (tp + fn)");
  });
export type CatalogSkillEvalScorecard = z.infer<typeof catalogSkillEvalScorecardSchema>;

/** SK20's eval rules with their Site-editable defaults. */
export const SKILL_EVAL_SUBMISSION_DEFAULTS = {
  minCases: 3,
  minNegativeTriggerCases: 1,
  minPassRate: 0.8,
  minLift: 0,
  minTriggerPrecision: 0.8,
} as const;
/** `site_skill_settings.submission_rules` (eval part): counts ≥ 0, ratios in 0..1, lift in −1..1. */
export const skillEvalSubmissionRulesSchema = z.strictObject({
  minCases: z.number().int().min(0).max(25).default(SKILL_EVAL_SUBMISSION_DEFAULTS.minCases),
  minNegativeTriggerCases: z
    .number()
    .int()
    .min(0)
    .max(25)
    .default(SKILL_EVAL_SUBMISSION_DEFAULTS.minNegativeTriggerCases),
  minPassRate: z.number().min(0).max(1).default(SKILL_EVAL_SUBMISSION_DEFAULTS.minPassRate),
  minLift: z.number().min(-1).max(1).default(SKILL_EVAL_SUBMISSION_DEFAULTS.minLift),
  minTriggerPrecision: z
    .number()
    .min(0)
    .max(1)
    .default(SKILL_EVAL_SUBMISSION_DEFAULTS.minTriggerPrecision),
});
export type SkillEvalSubmissionRules = z.infer<typeof skillEvalSubmissionRulesSchema>;

export const SKILL_EVAL_SUBMISSION_SHORTFALLS = [
  "stale",
  "too_few_cases",
  "no_negative_trigger_case",
  "pass_rate",
  "lift",
  "trigger_precision",
] as const;
export type SkillEvalSubmissionShortfall = (typeof SKILL_EVAL_SUBMISSION_SHORTFALLS)[number];

/**
 * Which SK20 eval rules a submission's scorecard misses (empty: none). A missing number fails its
 * rule: no lift (no baseline, or an errored pair) fails `lift`, and no precision (the skill was
 * never read, TP + FP = 0) fails `trigger_precision`. A scorecard of another package hash is
 * `stale` (freshness).
 */
export function skillEvalSubmissionShortfalls(
  card: CatalogSkillEvalScorecard,
  packageHash: string,
  rules: SkillEvalSubmissionRules = SKILL_EVAL_SUBMISSION_DEFAULTS,
): SkillEvalSubmissionShortfall[] {
  const out: SkillEvalSubmissionShortfall[] = [];
  if (card.packageHash !== packageHash) out.push("stale");
  if (card.cases < rules.minCases) out.push("too_few_cases");
  if (card.negativeTriggerCases < rules.minNegativeTriggerCases)
    out.push("no_negative_trigger_case");
  if (card.passRateWith < rules.minPassRate) out.push("pass_rate");
  if (card.lift === undefined || card.lift < rules.minLift) out.push("lift");
  if (card.triggerPrecision === undefined || card.triggerPrecision < rules.minTriggerPrecision)
    out.push("trigger_precision");
  return out;
}

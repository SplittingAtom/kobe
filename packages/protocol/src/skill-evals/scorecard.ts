import { z } from "zod";
import { timestampSchema, uuidSchema } from "../common.js";
import { SHA256_HEX_PATTERN } from "../skill-package/layout.js";
import type { SkillProvenance } from "../skill-package/provenance.js";
import { EVAL_CASE_ID_PATTERN, EVAL_MODEL_ALIAS_PATTERN, type SkillEvalSuite } from "./cases.js";
import {
  planSkillEvalExecutions,
  SKILL_EVAL_CASE_KINDS,
  SKILL_EVAL_MODES,
  skillEvalCaseKind,
  type SkillEvalMode,
} from "./plan.js";

/**
 * The eval scorecard (KOBE-324, spec SK16): what one eval run of one package hash found. It is
 * **team content**: per-case detail links to the eval threads and carries judge reasons, so it is
 * served only inside the team that ran it, like the threads themselves. What leaves the team is
 * {@link scorecardForProvenance}: numbers only (SK19).
 *
 * Definitions (code is the contract: {@link computeSkillEvalScorecard}):
 * - An **execution** passes when its run finished and every check it makes passed. One automatic
 *   retry per failing execution (SK16 risk table): the execution reports its final attempt;
 *   `totalCostUsd` includes the retry. Errors, timeouts (10 min per case), budget stops and
 *   cancellations count as not passed.
 * - **Pass rate**: passed / executions with the skill, over every case.
 * - **Baseline pass rate**: passed / executions without skills (`full` runs only).
 * - **Lift**: the with-skill pass rate over the baseline cases minus the baseline pass rate, so
 *   both sides cover the same cases (trigger-only cases have no baseline). Null without one.
 * - **Trigger precision / recall**: over with-skill executions of cases that set `triggers` and
 *   observed whether the skill was read (an error or cancellation observes nothing). precision =
 *   TP / (TP + FP), recall = TP / (TP + FN); null when the denominator is 0.
 * - **Mean cost / duration**: of the final attempts in a mode (judge spend excluded); `costUsd` is
 *   all model spend of the run's executions, retries included, and `judgeCostUsd` the judge's.
 *   Dollars are rounded to micro-dollars, durations to milliseconds.
 * - **Denied tool calls**: policy denials (in auto mode every would-ask call is one), summed.
 */

export const SKILL_EVAL_SCORECARD_FORMAT = 1;

/** Checks an execution makes, in this order. `triggers` only with the skill. */
export const SKILL_EVAL_CHECKS = [
  "triggers",
  "outputs",
  "contains",
  "matches",
  "judge",
  "max_cost_usd",
  "max_turns",
  "no_denied_tools",
] as const;
export type SkillEvalCheck = (typeof SKILL_EVAL_CHECKS)[number];

export const SKILL_EVAL_EXECUTION_STATUSES = [
  "passed",
  "failed",
  "error",
  "timed_out",
  "budget_stopped",
  "cancelled",
] as const;
export type SkillEvalExecutionStatus = (typeof SKILL_EVAL_EXECUTION_STATUSES)[number];
/** Statuses without an observation of whether the skill was read. */
const UNOBSERVED: ReadonlySet<SkillEvalExecutionStatus> = new Set(["error", "cancelled"]);

/** A check's short explanation (a judge's reason, the glob that matched nothing). Team content. */
export const EVAL_CHECK_DETAIL_MAX_CHARS = 1000;
export const EVAL_MAX_USD = 1_000_000;

const usd = z.number().min(0).max(EVAL_MAX_USD);
const ratio = z.number().min(0).max(1);
const count = z.number().int().min(0);
const alias = z.string().regex(EVAL_MODEL_ALIAS_PATTERN);
const caseId = z.string().regex(EVAL_CASE_ID_PATTERN);

export const skillEvalCheckResultSchema = z.strictObject({
  check: z.enum(SKILL_EVAL_CHECKS),
  passed: z.boolean(),
  detail: z.string().min(1).max(EVAL_CHECK_DETAIL_MAX_CHARS).optional(),
});
export type SkillEvalCheckResult = z.infer<typeof skillEvalCheckResultSchema>;

export const skillEvalExecutionSchema = z
  .strictObject({
    caseId,
    withSkill: z.boolean(),
    status: z.enum(SKILL_EVAL_EXECUTION_STATUSES),
    /** 2 when the automatic retry ran. */
    attempts: z.union([z.literal(1), z.literal(2)]),
    /** Whether the skill was read (KOBE-297); null without the skill or without an observation. */
    triggered: z.boolean().nullable(),
    checks: z.array(skillEvalCheckResultSchema).max(SKILL_EVAL_CHECKS.length),
    /** The alias the case ran on (SK17: reported on the case). */
    model: alias,
    /** The final attempt's model spend; `totalCostUsd` adds the retry. */
    costUsd: usd,
    totalCostUsd: usd,
    judgeCostUsd: usd,
    durationMs: count,
    turns: count,
    deniedToolCalls: count,
    /** The eval thread and run (team-scoped); null when no run started. */
    threadId: uuidSchema.nullable(),
    runId: uuidSchema.nullable(),
  })
  .superRefine((e, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const kinds = e.checks.map((c) => c.check);
    if (new Set(kinds).size !== kinds.length) fail("a check is listed twice");
    if (e.status === "passed" && (e.checks.length === 0 || e.checks.some((c) => !c.passed)))
      fail("passed needs every check passed");
    if (e.status === "failed" && e.checks.every((c) => c.passed))
      fail("failed needs a failed check");
    if (!e.withSkill && (e.triggered !== null || kinds.includes("triggers")))
      fail("a baseline execution observes no trigger");
    if (UNOBSERVED.has(e.status) && e.triggered !== null) fail("no observation in this status");
    if (e.costUsd > e.totalCostUsd) fail("costUsd is part of totalCostUsd");
    if (e.attempts === 1 && e.costUsd !== e.totalCostUsd) fail("one attempt, one cost");
  });
export type SkillEvalExecution = z.infer<typeof skillEvalExecutionSchema>;

export const skillEvalCaseDetailSchema = z.strictObject({
  caseId,
  kind: z.enum(SKILL_EVAL_CASE_KINDS),
  /** The case's `triggers` expectation; null when it sets none. */
  expectsTrigger: z.boolean().nullable(),
  with: skillEvalExecutionSchema,
  /** The baseline; null for trigger-only cases and in `with_only` runs. */
  without: skillEvalExecutionSchema.nullable(),
});
export type SkillEvalCaseDetail = z.infer<typeof skillEvalCaseDetailSchema>;

export const skillEvalModeSummarySchema = z.strictObject({
  executions: z.number().int().min(1),
  passed: count,
  passRate: ratio,
  meanCostUsd: usd,
  meanDurationMs: count,
  deniedToolCalls: count,
});
export type SkillEvalModeSummary = z.infer<typeof skillEvalModeSummarySchema>;

export const skillEvalRunModelSchema = z
  .strictObject({
    /** The suite's `model:`; null when it names none. */
    requested: alias.nullable(),
    used: alias,
    /** The team hasn't enabled `requested`, so the team default ran (never silent: SK17). */
    fellBack: z.boolean(),
  })
  .refine(
    (m) => m.fellBack === (m.requested !== null && m.requested !== m.used),
    "fellBack is requested ≠ used",
  );
export type SkillEvalRunModel = z.infer<typeof skillEvalRunModelSchema>;

/** The judge (SK17): the Site's alias, or the team's own when the team hasn't enabled it. */
export const skillEvalJudgeModelSchema = z.strictObject({
  alias,
  source: z.enum(["site", "team"]),
});
export type SkillEvalJudgeModel = z.infer<typeof skillEvalJudgeModelSchema>;

export const skillEvalScorecardSchema = z
  .strictObject({
    format: z.literal(SKILL_EVAL_SCORECARD_FORMAT),
    mode: z.enum(SKILL_EVAL_MODES),
    /** The package evaluated: a scorecard of another package hash is stale (SK20). */
    packageHash: z.string().regex(SHA256_HEX_PATTERN),
    runModel: skillEvalRunModelSchema,
    /** Null when no case has a `judge` rubric. */
    judgeModel: skillEvalJudgeModelSchema.nullable(),
    cases: z.number().int().min(1),
    negativeTriggerCases: count,
    baselineCases: count,
    passRate: ratio,
    baselinePassRate: ratio.nullable(),
    lift: z.number().min(-1).max(1).nullable(),
    triggerPrecision: ratio.nullable(),
    triggerRecall: ratio.nullable(),
    with: skillEvalModeSummarySchema,
    without: skillEvalModeSummarySchema.nullable(),
    costUsd: usd,
    judgeCostUsd: usd,
    details: z.array(skillEvalCaseDetailSchema).min(1),
    startedAt: timestampSchema,
    completedAt: timestampSchema,
  })
  .superRefine((s, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (s.details.length !== s.cases) fail("one detail per case");
    for (const d of s.details) {
      if (d.with.caseId !== d.caseId || !d.with.withSkill) fail(`${d.caseId}: with is its own`);
      if (d.without && (d.without.caseId !== d.caseId || d.without.withSkill))
        fail(`${d.caseId}: without is its own baseline`);
      const baseline = s.mode === "full" && d.kind === "behaviour";
      if (baseline !== (d.without !== null)) fail(`${d.caseId}: a baseline exactly when planned`);
    }
    if (s.mode === "with_only" && (s.without || s.baselinePassRate !== null || s.lift !== null))
      fail("a with_only run has no baseline");
    if ((s.without === null) !== (s.baselinePassRate === null)) fail("baseline numbers together");
  });
export type SkillEvalScorecard = z.infer<typeof skillEvalScorecardSchema>;

export class SkillEvalScorecardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillEvalScorecardError";
  }
}

export interface ComputeSkillEvalScorecardInput {
  readonly suite: SkillEvalSuite;
  readonly mode: SkillEvalMode;
  readonly packageHash: string;
  readonly runModel: SkillEvalRunModel;
  readonly judgeModel: SkillEvalJudgeModel | null;
  /** Exactly the planned executions (`planSkillEvalExecutions`), in any order. */
  readonly executions: readonly SkillEvalExecution[];
  readonly startedAt: string;
  readonly completedAt: string;
}

const roundUsd = (x: number) => Math.round(x * 1e6) / 1e6;
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const rate = (num: number, den: number) => (den === 0 ? null : num / den);
const key = (caseId: string, withSkill: boolean) => `${caseId}\u0000${withSkill ? 1 : 0}`;

function summarize(execs: readonly SkillEvalExecution[]): SkillEvalModeSummary | null {
  if (execs.length === 0) return null;
  const passed = execs.filter((e) => e.status === "passed").length;
  return {
    executions: execs.length,
    passed,
    passRate: passed / execs.length,
    meanCostUsd: roundUsd(sum(execs.map((e) => e.costUsd)) / execs.length),
    meanDurationMs: Math.round(sum(execs.map((e) => e.durationMs)) / execs.length),
    deniedToolCalls: sum(execs.map((e) => e.deniedToolCalls)),
  };
}

function indexExecutions(input: ComputeSkillEvalScorecardInput) {
  const planned = new Set(
    planSkillEvalExecutions(input.suite, input.mode).map((p) => key(p.caseId, p.withSkill)),
  );
  const found = new Map<string, SkillEvalExecution>();
  for (const raw of input.executions) {
    const e = skillEvalExecutionSchema.parse(raw);
    const k = key(e.caseId, e.withSkill);
    const label = `${e.caseId} ${e.withSkill ? "with" : "without"} the skill`;
    if (!planned.has(k))
      throw new SkillEvalScorecardError(`${label} is not planned in a ${input.mode} run`);
    if (found.has(k)) throw new SkillEvalScorecardError(`${label} is reported twice`);
    found.set(k, e);
  }
  for (const k of planned)
    if (!found.has(k))
      throw new SkillEvalScorecardError(`${k.split("\u0000")[0]} is missing an execution`);
  return found;
}

/** The scorecard of a finished run; throws when the executions are not exactly the plan. */
export function computeSkillEvalScorecard(
  input: ComputeSkillEvalScorecardInput,
): SkillEvalScorecard {
  const found = indexExecutions(input);
  const details: SkillEvalCaseDetail[] = input.suite.cases.map((c) => ({
    caseId: c.id,
    kind: skillEvalCaseKind(c),
    expectsTrigger: c.expect.triggers ?? null,
    with: found.get(key(c.id, true)) as SkillEvalExecution,
    without: found.get(key(c.id, false)) ?? null,
  }));
  const withs = details.map((d) => d.with);
  const withouts = details.flatMap((d) => (d.without ? [d.without] : []));
  const baselineWiths = details.flatMap((d) => (d.without ? [d.with] : []));
  const observed = details.filter(
    (d) => d.expectsTrigger !== null && d.with.triggered !== null && !UNOBSERVED.has(d.with.status),
  );
  const tp = observed.filter((d) => d.expectsTrigger && d.with.triggered).length;
  const fp = observed.filter((d) => !d.expectsTrigger && d.with.triggered).length;
  const fn = observed.filter((d) => d.expectsTrigger && !d.with.triggered).length;
  const withSummary = summarize(withs) as SkillEvalModeSummary;
  const without = summarize(withouts);
  const baselineWith = summarize(baselineWiths);
  const all = [...withs, ...withouts];
  return skillEvalScorecardSchema.parse({
    format: SKILL_EVAL_SCORECARD_FORMAT,
    mode: input.mode,
    packageHash: input.packageHash,
    runModel: input.runModel,
    judgeModel: input.judgeModel,
    cases: details.length,
    negativeTriggerCases: details.filter((d) => d.kind === "negative_trigger").length,
    baselineCases: input.suite.cases.filter((c) => skillEvalCaseKind(c) === "behaviour").length,
    passRate: withSummary.passRate,
    baselinePassRate: without?.passRate ?? null,
    lift: without && baselineWith ? baselineWith.passRate - without.passRate : null,
    triggerPrecision: rate(tp, tp + fp),
    triggerRecall: rate(tp, tp + fn),
    with: withSummary,
    without,
    costUsd: roundUsd(sum(all.map((e) => e.totalCostUsd))),
    judgeCostUsd: roundUsd(sum(all.map((e) => e.judgeCostUsd))),
    details,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  });
}

/**
 * The scorecard as `provenance.json` carries it (SK19): numbers only. No case ids, prompts,
 * answers, check details, judge reasons, thread or run ids, and no model names leave the team.
 * `costUsd` is all eval spend, judge included.
 */
export function scorecardForProvenance(
  card: SkillEvalScorecard,
  at: string,
): NonNullable<SkillProvenance["scorecard"]> {
  return {
    packageHash: card.packageHash,
    mode: card.mode,
    cases: card.cases,
    negativeTriggerCases: card.negativeTriggerCases,
    passRateWith: card.passRate,
    ...(card.baselinePassRate === null ? {} : { passRateWithout: card.baselinePassRate }),
    ...(card.lift === null ? {} : { lift: card.lift }),
    ...(card.triggerPrecision === null ? {} : { triggerPrecision: card.triggerPrecision }),
    ...(card.triggerRecall === null ? {} : { triggerRecall: card.triggerRecall }),
    costUsd: roundUsd(card.costUsd + card.judgeCostUsd),
    at,
  };
}

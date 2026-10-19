import { z } from "zod";
import { timestampSchema, uuidSchema } from "../common.js";
import { SHA256_HEX_PATTERN } from "../skill-package/layout.js";
import {
  SKILL_EVAL_LIFT_UNAVAILABLE,
  skillEvalTriggerCountsSchema,
  type SkillEvalTriggerCounts,
} from "./catalog-scorecard.js";
import { EVAL_CASE_ID_PATTERN, EVAL_MODEL_ALIAS_PATTERN } from "./cases.js";
import { SKILL_EVAL_CASE_KINDS, SKILL_EVAL_CHECKS, SKILL_EVAL_MODES } from "./plan.js";

/**
 * The team's eval scorecard (KOBE-324, spec SK16): what one eval run of one package hash found.
 * It is **team content**: per-case detail links to the eval threads and carries judge reasons, so
 * it is served only inside the team that ran it, like the threads themselves, and never written to
 * a site-wide table, event or export. What may leave is `CatalogSkillEvalScorecard`
 * (`scorecardForProvenance`): numbers only (SK19).
 *
 * Every number is defined by `computeSkillEvalScorecard` (`compute.ts`), and
 * `verifySkillEvalScorecard` recomputes a stored card from its executions, so a forged aggregate
 * is one call to detect (SK20 reads the submitted card).
 *
 * Executions (one case, one sandbox, with or without the skill):
 * - **Statuses in a scorecard:** `passed`, `failed`, `error` (infrastructure: no observation),
 *   `timed_out` (10 min per case: a real failure). Only a `completed` eval run has a scorecard; a
 *   cancelled or budget-stopped run (D30) has partial results and none.
 * - **Retry:** one automatic retry after `failed`, `error` or `timed_out`. The execution reports
 *   the final attempt: `costUsd` (what `max_cost_usd` checks) and `durationMs` are the final
 *   attempt's; `totalCostUsd`, `totalDurationMs` and `judgeCostUsd` cover both attempts.
 * - **Reconciliation:** a card's `costUsd` is the sum of its executions' `totalCostUsd`, equal to
 *   the eval run's `run_usage` rows of kind `eval`; its `judgeCostUsd` equals the `eval_judge` rows.
 * - **Triggered** comes from the run's recorded skill uses (`runs.skills_used`, KOBE-297), carried
 *   as `skillUses`: `triggered` is `skillUses > 0` with the skill, null without it or after an
 *   error. The `triggers` check passes exactly when `triggered` equals the case's expectation.
 * - **Denied tool calls:** the run's `policy.denied` events (in auto mode every would-ask call is
 *   one); egress refusals inside a tool are not counted.
 *
 * Forward compatibility: an added optional field keeps `format: 1`; a removed or changed field
 * bumps it, and readers of stored cards parse a union by `format`. API responses are strict, so
 * the web client is deployed with (never before) the server that adds a field.
 */

export const SKILL_EVAL_SCORECARD_FORMAT = 1;

/** Every status an execution passes through (progress events); a scorecard holds the first four. */
export const SKILL_EVAL_EXECUTION_STATUSES = [
  "passed",
  "failed",
  "error",
  "timed_out",
  "budget_stopped",
  "cancelled",
] as const;
export type SkillEvalExecutionStatus = (typeof SKILL_EVAL_EXECUTION_STATUSES)[number];
export const SKILL_EVAL_SCORED_STATUSES = ["passed", "failed", "error", "timed_out"] as const;
export type SkillEvalScoredStatus = (typeof SKILL_EVAL_SCORED_STATUSES)[number];

/** Why a check failed, so the runner, the judge and the Workbench agree. */
export const SKILL_EVAL_CHECK_REASONS = [
  "not_triggered",
  "unexpected_trigger",
  "not_produced",
  "over_cap",
  "no_match",
  "match_timeout",
  "judge_failed",
  "judge_unparseable",
  "judge_rejected",
  "over_limit",
  "denied",
] as const;
export type SkillEvalCheckReason = (typeof SKILL_EVAL_CHECK_REASONS)[number];

/** A check's short explanation (a judge's reason, the glob that matched nothing). Team content. */
export const EVAL_CHECK_DETAIL_MAX_CHARS = 1000;
export const EVAL_MAX_USD = 1_000_000;

const usd = z.number().min(0).max(EVAL_MAX_USD);
const ratio = z.number().min(0).max(1);
const count = z.number().int().min(0);
const alias = z.string().regex(EVAL_MODEL_ALIAS_PATTERN);
const caseId = z.string().regex(EVAL_CASE_ID_PATTERN);

export const skillEvalCheckResultSchema = z
  .strictObject({
    check: z.enum(SKILL_EVAL_CHECKS),
    passed: z.boolean(),
    /** Set exactly when the check failed. */
    reason: z.enum(SKILL_EVAL_CHECK_REASONS).optional(),
    detail: z.string().min(1).max(EVAL_CHECK_DETAIL_MAX_CHARS).optional(),
  })
  .refine((c) => c.passed === (c.reason === undefined), "a failed check has a reason");
export type SkillEvalCheckResult = z.infer<typeof skillEvalCheckResultSchema>;

export const skillEvalExecutionSchema = z
  .strictObject({
    caseId,
    withSkill: z.boolean(),
    status: z.enum(SKILL_EVAL_SCORED_STATUSES),
    /** 2 when the automatic retry ran. */
    attempts: z.union([z.literal(1), z.literal(2)]),
    /** Recorded reads of the skill in the final attempt's run (`runs.skills_used`). */
    skillUses: count,
    /** Derived: `skillUses > 0` with the skill; null without it or after an error. */
    triggered: z.boolean().nullable(),
    checks: z.array(skillEvalCheckResultSchema).max(SKILL_EVAL_CHECKS.length),
    /** The alias the case ran on (SK17: reported on the case). */
    model: alias,
    costUsd: usd,
    totalCostUsd: usd,
    judgeCostUsd: usd,
    durationMs: count,
    totalDurationMs: count,
    /** Model calls of the final attempt's run. */
    turns: count,
    deniedToolCalls: count,
    /** The eval thread and run (team-scoped); null when no run started. */
    threadId: uuidSchema.nullable(),
    runId: uuidSchema.nullable(),
  })
  .superRefine((e, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const kinds = e.checks.map((c) => c.check);
    const order = kinds.map((k) => SKILL_EVAL_CHECKS.indexOf(k));
    if (order.some((x, i) => i > 0 && x <= (order[i - 1] ?? -1)))
      fail("checks are listed once each, in SKILL_EVAL_CHECKS order");
    if (e.status === "passed" && (e.checks.length === 0 || e.checks.some((c) => !c.passed)))
      fail("passed needs every check passed");
    if (e.status === "failed" && e.checks.every((c) => c.passed))
      fail("failed needs a failed check");
    if (!e.withSkill && e.skillUses !== 0) fail("a baseline loads no skill");
    const derived = e.withSkill && e.status !== "error" ? e.skillUses > 0 : null;
    if (e.triggered !== derived) fail("triggered is derived from skillUses");
    if (e.costUsd > e.totalCostUsd || e.durationMs > e.totalDurationMs)
      fail("the final attempt is part of the totals");
    if (e.attempts === 1 && (e.costUsd !== e.totalCostUsd || e.durationMs !== e.totalDurationMs))
      fail("one attempt, one cost and duration");
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
  failed: count,
  errored: count,
  timedOut: count,
  passRate: ratio,
  /** Of final attempts; judge spend excluded. */
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
    /** Behaviour cases: those a `full` run also runs without the skill (also in `with_only`). */
    baselineCases: count,
    passRate: ratio,
    baselinePassRate: ratio.nullable(),
    lift: z.number().min(-1).max(1).nullable(),
    /** Set exactly when `lift` is null. */
    liftUnavailable: z.enum(SKILL_EVAL_LIFT_UNAVAILABLE).nullable(),
    triggerPrecision: ratio.nullable(),
    triggerRecall: ratio.nullable(),
    triggerCounts: skillEvalTriggerCountsSchema,
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
    if ((s.lift === null) !== (s.liftUnavailable !== null)) fail("lift or why it is unavailable");
    if (Date.parse(s.completedAt) < Date.parse(s.startedAt)) fail("completedAt ≥ startedAt");
  });
export type SkillEvalScorecard = z.infer<typeof skillEvalScorecardSchema>;
export type { SkillEvalTriggerCounts };

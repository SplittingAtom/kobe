import { canonicalJson } from "../canonical-json.js";
import {
  catalogSkillEvalScorecardSchema,
  type CatalogSkillEvalScorecard,
  type SkillEvalLiftUnavailable,
  type SkillEvalStatusCounts,
} from "./catalog-scorecard.js";
import type { SkillEvalCase, SkillEvalSuite } from "./cases.js";
import {
  expectedChecks,
  planSkillEvalExecutions,
  skillEvalCaseKind,
  type SkillEvalMode,
} from "./plan.js";
import {
  SKILL_EVAL_SCORECARD_FORMAT,
  skillEvalExecutionSchema,
  skillEvalScorecardSchema,
  type SkillEvalCaseDetail,
  type SkillEvalExecution,
  type SkillEvalJudgeModel,
  type SkillEvalModeSummary,
  type SkillEvalRunModel,
  type SkillEvalScorecard,
} from "./scorecard.js";

/**
 * The scorecard's numbers (KOBE-324, spec SK16), defined once:
 * - **Pass rate**: passed / with-skill executions, over every case.
 * - **Baseline pass rate**: passed / executions without skills (`full` runs only, else null).
 * - **Lift**: the with-skill pass rate over the baseline cases minus the baseline pass rate, so
 *   both sides cover the same cases. Null with a reason when there is no baseline, or when either
 *   side of any baseline pair errored (an infrastructure failure is not evidence, so it can never
 *   make lift look good). The with side also makes the `triggers` check when the case sets it, so a
 *   skill that never fires on a case the bare model solves shows negative lift: on purpose.
 * - **Trigger precision / recall**: over with-skill executions of cases that set `triggers`,
 *   errors excluded: TP / (TP + FP) and TP / (TP + FN), null when the denominator is 0. The
 *   counts are on the card (`triggerCounts`).
 * - **Means** per mode: of final attempts, judge excluded; micro-dollar and millisecond rounding.
 */

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
const statusCount = (execs: readonly SkillEvalExecution[], s: SkillEvalExecution["status"]) =>
  execs.filter((e) => e.status === s).length;

function summarize(execs: readonly SkillEvalExecution[]): SkillEvalModeSummary | null {
  if (execs.length === 0) return null;
  const passed = statusCount(execs, "passed");
  return {
    executions: execs.length,
    passed,
    failed: statusCount(execs, "failed"),
    errored: statusCount(execs, "error"),
    timedOut: statusCount(execs, "timed_out"),
    passRate: passed / execs.length,
    meanCostUsd: roundUsd(sum(execs.map((e) => e.costUsd)) / execs.length),
    meanDurationMs: Math.round(sum(execs.map((e) => e.durationMs)) / execs.length),
    deniedToolCalls: sum(execs.map((e) => e.deniedToolCalls)),
  };
}

/** Refuses an execution whose checks are not the case's (or whose trigger check contradicts it). */
function checkAgainstCase(e: SkillEvalExecution, c: SkillEvalCase, label: string) {
  const expected = expectedChecks(c, e.withSkill);
  const listed = e.checks.map((x) => x.check);
  const extra = listed.filter((k) => !expected.includes(k));
  if (extra.length > 0)
    throw new SkillEvalScorecardError(
      `${label} makes checks its case doesn't: ${extra.join(", ")}`,
    );
  if (e.status === "passed" && listed.length !== expected.length)
    throw new SkillEvalScorecardError(
      `${label} passed without ${expected.filter((k) => !listed.includes(k)).join(", ")}`,
    );
  const trigger = e.checks.find((x) => x.check === "triggers");
  if (trigger && (e.triggered === null || trigger.passed !== (e.triggered === c.expect.triggers)))
    throw new SkillEvalScorecardError(
      `${label}: the triggers check contradicts the recorded skill use`,
    );
}

function indexExecutions(input: ComputeSkillEvalScorecardInput) {
  const cases = new Map(input.suite.cases.map((c) => [c.id, c] as const));
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
    checkAgainstCase(e, cases.get(e.caseId) as SkillEvalCase, label);
    found.set(k, e);
  }
  for (const k of planned)
    if (!found.has(k))
      throw new SkillEvalScorecardError(`${k.split("\u0000")[0]} is missing an execution`);
  return found;
}

function liftOf(mode: SkillEvalMode, details: readonly SkillEvalCaseDetail[]) {
  const pairs = details.flatMap((d) => (d.without ? [[d.with, d.without] as const] : []));
  const none = (reason: SkillEvalLiftUnavailable) => ({ lift: null, liftUnavailable: reason });
  if (mode === "with_only") return none("with_only");
  if (pairs.length === 0) return none("no_baseline_cases");
  if (pairs.some(([w, wo]) => w.status === "error" || wo.status === "error"))
    return none("incomplete_pairs");
  const passed = (xs: readonly SkillEvalExecution[]) =>
    xs.filter((e) => e.status === "passed").length / xs.length;
  return {
    lift: passed(pairs.map(([w]) => w)) - passed(pairs.map(([, wo]) => wo)),
    liftUnavailable: null,
  };
}

function triggerCountsOf(details: readonly SkillEvalCaseDetail[]) {
  const observed = details.filter((d) => d.expectsTrigger !== null && d.with.triggered !== null);
  const n = (expected: boolean, read: boolean) =>
    observed.filter((d) => d.expectsTrigger === expected && d.with.triggered === read).length;
  return {
    observed: observed.length,
    tp: n(true, true),
    fp: n(false, true),
    fn: n(true, false),
    tn: n(false, false),
  };
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
  const t = triggerCountsOf(details);
  const withSummary = summarize(withs) as SkillEvalModeSummary;
  const without = summarize(withouts);
  const all = [...withs, ...withouts];
  return skillEvalScorecardSchema.parse({
    format: SKILL_EVAL_SCORECARD_FORMAT,
    mode: input.mode,
    packageHash: input.packageHash,
    runModel: input.runModel,
    judgeModel: input.judgeModel,
    cases: details.length,
    negativeTriggerCases: details.filter((d) => d.kind === "negative_trigger").length,
    baselineCases: details.filter((d) => d.kind === "behaviour").length,
    passRate: withSummary.passRate,
    baselinePassRate: without?.passRate ?? null,
    ...liftOf(input.mode, details),
    triggerPrecision: rate(t.tp, t.tp + t.fp),
    triggerRecall: rate(t.tp, t.tp + t.fn),
    triggerCounts: t,
    with: withSummary,
    without,
    costUsd: roundUsd(sum(all.map((e) => e.totalCostUsd))),
    judgeCostUsd: roundUsd(sum(all.map((e) => e.judgeCostUsd))),
    details,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  });
}

export type SkillEvalVerification =
  | { readonly ok: true; readonly scorecard: SkillEvalScorecard }
  | { readonly ok: false; readonly problem: string };

/**
 * Recomputes a stored card from the suite of its package and its executions (the card's own
 * details unless the stored execution rows are given) and compares the whole card. Any forged
 * aggregate, a check set that isn't its case's, a contradicted trigger, or a missing or unplanned
 * execution fails.
 */
export function verifySkillEvalScorecard(
  card: unknown,
  suite: SkillEvalSuite,
  executions?: readonly SkillEvalExecution[],
): SkillEvalVerification {
  const parsed = skillEvalScorecardSchema.safeParse(card);
  if (!parsed.success)
    return { ok: false, problem: parsed.error.issues[0]?.message ?? "not a scorecard" };
  const c = parsed.data;
  let again: SkillEvalScorecard;
  try {
    again = computeSkillEvalScorecard({
      suite,
      mode: c.mode,
      packageHash: c.packageHash,
      runModel: c.runModel,
      judgeModel: c.judgeModel,
      executions:
        executions ?? c.details.flatMap((d) => (d.without ? [d.with, d.without] : [d.with])),
      startedAt: c.startedAt,
      completedAt: c.completedAt,
    });
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : String(err) };
  }
  return canonicalJson(again) === canonicalJson(c)
    ? { ok: true, scorecard: c }
    : { ok: false, problem: "the numbers differ from the executions" };
}

const counts = (m: SkillEvalModeSummary): SkillEvalStatusCounts => ({
  executions: m.executions,
  passed: m.passed,
  failed: m.failed,
  errored: m.errored,
  timedOut: m.timedOut,
});

/**
 * The card as it may leave the team (`CatalogSkillEvalScorecard`, SK19): numbers only, no case
 * ids, prompts, answers, check details, judge reasons, model names, thread or run ids. Refuses a
 * `with_only` card (SK16: submissions use a full run). `costUsd` is all spend, judge included.
 */
export function scorecardForProvenance(
  card: SkillEvalScorecard,
  at: string,
): CatalogSkillEvalScorecard {
  if (card.mode !== "full")
    throw new SkillEvalScorecardError("only a full run's scorecard leaves the team");
  return catalogSkillEvalScorecardSchema.parse({
    packageHash: card.packageHash,
    mode: "full",
    cases: card.cases,
    negativeTriggerCases: card.negativeTriggerCases,
    baselineCases: card.baselineCases,
    passRateWith: card.passRate,
    ...(card.baselinePassRate === null ? {} : { passRateWithout: card.baselinePassRate }),
    ...(card.lift === null ? { liftUnavailable: card.liftUnavailable } : { lift: card.lift }),
    ...(card.triggerPrecision === null ? {} : { triggerPrecision: card.triggerPrecision }),
    ...(card.triggerRecall === null ? {} : { triggerRecall: card.triggerRecall }),
    triggerCounts: card.triggerCounts,
    executions: {
      with: counts(card.with),
      ...(card.without ? { without: counts(card.without) } : {}),
    },
    costUsd: roundUsd(card.costUsd + card.judgeCostUsd),
    ...(card.judgeModel ? { judge: { source: card.judgeModel.source } } : {}),
    runModelFellBack: card.runModel.fellBack,
    at,
  });
}

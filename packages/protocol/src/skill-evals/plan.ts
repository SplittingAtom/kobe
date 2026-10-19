import { EVAL_BEHAVIOUR_CHECKS, type SkillEvalCase, type SkillEvalSuite } from "./cases.js";

/**
 * Which executions an eval run makes (KOBE-324, spec SK16). One execution is one case in one
 * fresh sandbox, either **with only this skill** or **with no skills** (the baseline).
 *
 * - A **negative trigger case** (`triggers: false`) runs with the skill only: without it, "not
 *   read" is a given.
 * - A **positive trigger case** (`triggers: true` and no behaviour check) runs with the skill
 *   only too: its one check can't be made without the skill, so a baseline would pass vacuously.
 *   (A departure from SK16's "every case but negative ones", recorded in the KOBE-324 ledger.)
 * - A **behaviour case** (any of outputs, contains, matches, judge; `triggers: true` optional)
 *   also runs as a baseline in a `full` run. The baseline makes every check but `triggers`.
 * - `with_only` (Workbench quick runs) makes the with-skill executions alone. Submissions always
 *   use `full` (SK16).
 */

export const SKILL_EVAL_MODES = ["full", "with_only"] as const;
export type SkillEvalMode = (typeof SKILL_EVAL_MODES)[number];

export const SKILL_EVAL_CASE_KINDS = ["positive_trigger", "negative_trigger", "behaviour"] as const;
export type SkillEvalCaseKind = (typeof SKILL_EVAL_CASE_KINDS)[number];

const hasBehaviourCheck = (c: SkillEvalCase) =>
  EVAL_BEHAVIOUR_CHECKS.some((k) => c.expect[k] !== undefined);

export function skillEvalCaseKind(c: SkillEvalCase): SkillEvalCaseKind {
  if (c.expect.triggers === false) return "negative_trigger";
  return hasBehaviourCheck(c) ? "behaviour" : "positive_trigger";
}

/** Checks an execution makes, in this order. */
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

/**
 * The checks an execution of `c` must make, in {@link SKILL_EVAL_CHECKS} order: `triggers` with
 * the skill when the case sets it; each behaviour check it sets; `max_cost_usd` when set;
 * `max_turns` always; `no_denied_tools` when true. A passed execution lists exactly these, all
 * passed; a failed one a subset (the runner skips the judge once another check failed) with at
 * least one failure. A missing check never counts as passed.
 */
export function expectedChecks(c: SkillEvalCase, withSkill: boolean): SkillEvalCheck[] {
  const e = c.expect;
  const on: Record<SkillEvalCheck, boolean> = {
    triggers: withSkill && e.triggers !== undefined,
    outputs: e.outputs !== undefined,
    contains: e.contains !== undefined,
    matches: e.matches !== undefined,
    judge: e.judge !== undefined,
    max_cost_usd: e.max_cost_usd !== undefined,
    max_turns: true,
    no_denied_tools: e.no_denied_tools === true,
  };
  return SKILL_EVAL_CHECKS.filter((k) => on[k]);
}

/** Whether a `full` run also makes this case's baseline execution. */
export const runsBaseline = (c: SkillEvalCase): boolean => skillEvalCaseKind(c) === "behaviour";

export interface SkillEvalPlannedExecution {
  readonly caseId: string;
  readonly withSkill: boolean;
}

/** The executions of a run, in order: each case with the skill, then its baseline if any. */
export function planSkillEvalExecutions(
  suite: SkillEvalSuite,
  mode: SkillEvalMode,
): SkillEvalPlannedExecution[] {
  return suite.cases.flatMap((c) =>
    mode === "full" && runsBaseline(c)
      ? [
          { caseId: c.id, withSkill: true },
          { caseId: c.id, withSkill: false },
        ]
      : [{ caseId: c.id, withSkill: true }],
  );
}

export interface SkillEvalSuiteCounts {
  readonly cases: number;
  /** Cases of kind `positive_trigger` (trigger-only). */
  readonly positiveTriggerCases: number;
  /** Cases with `triggers: true`, behaviour cases included (the recall denominator). */
  readonly casesExpectingTrigger: number;
  readonly negativeTriggerCases: number;
  readonly behaviourCases: number;
  /** Cases a `full` run also runs without the skill. */
  readonly baselineCases: number;
}

/** Counts for the Run button, the estimate (KOBE-327) and the submission rules (SK20). */
export function skillEvalSuiteCounts(suite: SkillEvalSuite): SkillEvalSuiteCounts {
  const kinds = suite.cases.map(skillEvalCaseKind);
  const count = (k: SkillEvalCaseKind) => kinds.filter((x) => x === k).length;
  return {
    cases: suite.cases.length,
    positiveTriggerCases: count("positive_trigger"),
    casesExpectingTrigger: suite.cases.filter((c) => c.expect.triggers === true).length,
    negativeTriggerCases: count("negative_trigger"),
    behaviourCases: count("behaviour"),
    baselineCases: suite.cases.filter(runsBaseline).length,
  };
}

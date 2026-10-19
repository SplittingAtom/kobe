import {
  skillEvalExecutionSchema,
  type SkillEvalCheckResult,
  type SkillEvalExecution,
  type SkillEvalRunModel,
  type SkillEvalScoredStatus,
} from "@kobe/protocol";

// One execution's record from its attempts (KOBE-325; contract KOBE-324 `skillEvalExecutionSchema`):
// the final attempt reports status, checks, uses, turns, denials and its own cost and duration;
// totals cover both attempts. One automatic retry after failed, error or timed_out.

/** One attempt (one thread, one sandbox, one run) as the runner finished it. */
export interface EvalAttempt {
  readonly status: SkillEvalScoredStatus;
  readonly checks: readonly SkillEvalCheckResult[];
  readonly skillUses: number;
  readonly costUsd: number;
  readonly judgeCostUsd: number;
  readonly durationMs: number;
  readonly turns: number;
  readonly deniedToolCalls: number;
  readonly threadId: string | null;
  readonly runId: string | null;
}

/** Whether an attempt gets the one automatic retry. */
export const retries = (attempt: EvalAttempt, attemptNo: number): boolean =>
  attemptNo === 1 && attempt.status !== "passed";

const roundUsd = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * The execution of `attempts` (one or two, final last), validated against the contract. It
 * reports the model it ran on and, when the team hasn't enabled the suite's model, that alias
 * (KOBE-326, SK17: never a silent fallback).
 */
export function executionFromAttempts(
  caseId: string,
  withSkill: boolean,
  runModel: SkillEvalRunModel,
  attempts: readonly [EvalAttempt] | readonly [EvalAttempt, EvalAttempt],
): SkillEvalExecution {
  const final = attempts[attempts.length - 1] as EvalAttempt;
  const skillUses = withSkill ? final.skillUses : 0;
  const total = (f: (a: EvalAttempt) => number) => attempts.reduce((n, a) => n + f(a), 0);
  const costUsd = roundUsd(final.costUsd);
  return skillEvalExecutionSchema.parse({
    caseId,
    withSkill,
    status: final.status,
    attempts: attempts.length,
    skillUses,
    triggered: withSkill && final.status !== "error" ? skillUses > 0 : null,
    checks: final.checks,
    model: runModel.used,
    ...(runModel.fellBack && runModel.requested ? { requestedModel: runModel.requested } : {}),
    costUsd,
    totalCostUsd: attempts.length === 1 ? costUsd : roundUsd(total((a) => a.costUsd)),
    judgeCostUsd: roundUsd(total((a) => a.judgeCostUsd)),
    durationMs: Math.round(final.durationMs),
    totalDurationMs:
      attempts.length === 1 ? Math.round(final.durationMs) : Math.round(total((a) => a.durationMs)),
    turns: final.turns,
    deniedToolCalls: final.deniedToolCalls,
    threadId: final.threadId,
    runId: final.runId,
  });
}

/** An attempt that never produced an observation (sandbox or run start failed). */
export const errorAttempt = (
  threadId: string | null,
  runId: string | null,
  durationMs: number,
  costUsd = 0,
): EvalAttempt => ({
  status: "error",
  checks: [],
  skillUses: 0,
  costUsd,
  judgeCostUsd: 0,
  durationMs,
  turns: 0,
  deniedToolCalls: 0,
  threadId,
  runId,
});

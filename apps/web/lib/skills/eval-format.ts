import type {
  SkillEvalCheckReason,
  SkillEvalExecutionStatus,
  SkillEvalRunStatus,
} from "@kobe/protocol";

/** Words for an eval's numbers and codes, shared by the panel, the history and the scorecard. */

export const pct = (x: number | null | undefined): string =>
  x === null || x === undefined ? "—" : `${Math.round(x * 100)} %`;

/** "+12 points", "−3 points", or "—". */
export function liftText(lift: number | null | undefined): string {
  if (lift === null || lift === undefined) return "—";
  const p = Math.round(lift * 100);
  return `${p > 0 ? "+" : ""}${p} points`;
}

export const usd = (x: number | undefined): string =>
  x === undefined ? "—" : x < 0.01 && x > 0 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`;

export const RUN_STATUS_TEXT: Readonly<Record<SkillEvalRunStatus, string>> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  budget_stopped: "Stopped by a budget",
};

export const EXECUTION_STATUS_TEXT: Readonly<Record<SkillEvalExecutionStatus, string>> = {
  passed: "Passed",
  failed: "Failed",
  error: "Errored (no result)",
  timed_out: "Timed out",
  budget_stopped: "Stopped by a budget",
  cancelled: "Cancelled",
};

/** Why a check failed, in words (the contract's reason codes). */
export const CHECK_REASON_TEXT: Readonly<Record<SkillEvalCheckReason, string>> = {
  not_triggered: "the skill was not used",
  unexpected_trigger: "the skill was used but should not have been",
  not_produced: "the expected file was not produced",
  over_cap: "too many or too large output files",
  no_match: "the answer did not contain what was expected",
  match_timeout: "the pattern took too long to check",
  judge_failed: "the judge could not grade it",
  judge_unparseable: "the judge's reply could not be read",
  judge_rejected: "the judge said the rubric was not met",
  over_limit: "it went over its cost or turn limit",
  denied: "a tool call was denied",
};

/** The checks' names, in words. */
export const CHECK_TEXT: Readonly<Record<string, string>> = {
  triggers: "Trigger",
  outputs: "Output files",
  contains: "Answer contains",
  matches: "Answer matches",
  judge: "Judge",
  max_cost_usd: "Cost limit",
  max_turns: "Turn limit",
  no_denied_tools: "No denied tools",
};

export const isOpen = (status: SkillEvalRunStatus): boolean =>
  status === "queued" || status === "running";

/**
 * How shared eval cases counted in a pre-publish eval (KOBE-276), in words for the builder's eval
 * status and the eval report. Ids and counts only: an eval never carries case text.
 */
import type { AgentEval, EvalCaseCounts } from "./api/team/agent-builder";
import { percent } from "./orbit-score";

const cases = (n: number): string => (n === 1 ? "1 shared case" : `${n} shared cases`);
const accepted = (n: number): string =>
  n === 1 ? "1 accepted case was" : `${n} accepted cases were`;

/** Why accepted cases were left out, by the server's reason (camelized). */
const SKIP_REASONS: Readonly<Record<string, string>> = {
  noReviewer:
    "the agent's owner can't review cases now (they left the team or may no longer build agents)",
};

/** "1 of 2 shared cases failed (50%); the team's limit is 10%.", or null when none ran. */
export function caseOutcome(counts: EvalCaseCounts | undefined, threshold: number): string | null {
  if (!counts || counts.total === 0) return null;
  if (counts.scored === null) return `${cases(counts.total)} in this evaluation.`;
  const failed = counts.failed ?? 0;
  const rate = counts.failureRate === null ? "" : ` (${percent(counts.failureRate)})`;
  return `${failed} of ${cases(counts.scored)} failed${rate}; the team's limit is ${percent(threshold)}.`;
}

/** One sentence per reason accepted cases were left out of the eval. */
export function caseSkips(counts: EvalCaseCounts | undefined): readonly string[] {
  if (!counts) return [];
  return Object.entries(counts.skipped)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => {
      const why = SKIP_REASONS[reason];
      return `${accepted(n)} left out${why ? `: ${why}` : ""}.`;
    });
}

/**
 * A block that came from the shared cases: the attack success rate stayed within the limit (or
 * has none), and the cases' failure rate is above it.
 */
export function blockedByCases(result: AgentEval): boolean {
  return (
    result.status === "blocked" &&
    (result.attackSuccessRate === null || result.attackSuccessRate <= result.threshold) &&
    (result.cases?.failureRate ?? 0) > result.threshold
  );
}

/**
 * Why a Registry review action is refused (KOBE-334): codes and messages shared by Approve, the
 * other decisions, acknowledgements and the console.
 */

export interface Problem {
  readonly code: string;
  readonly message: string;
}

export type ProblemCode =
  | "registry_not_ready"
  | "not_found"
  | "decided"
  | "claimed"
  | "authoritative_scorecard_missing"
  | "authoritative_scorecard_stale"
  | "blocked"
  | "block_verdict"
  | "own_submission"
  | "confirmed_by_you"
  | "not_maintainer"
  | "findings_unacknowledged"
  | "scan_override_reason"
  | "archived"
  | "submitter_deactivated";

/** States Approve and Request changes act on (the first decision wins). */
export const DECIDABLE_STATES: ReadonlySet<string> = new Set(["submitted", "in_review"]);
/**
 * States Reject (and Reject and block) act on (review M3): a version sent back with Request
 * changes can still be rejected, so it never holds its name for good.
 */
export const REJECTABLE_STATES: ReadonlySet<string> = new Set([
  "submitted",
  "in_review",
  "changes_requested",
]);

export const PROBLEMS = {
  registry_not_ready: {
    code: "registry_not_ready",
    message: "The Registry is not ready: a Site admin creates the Registry team first.",
  },
  not_found: { code: "not_found", message: "No such Registry version." },
  decided: { code: "decided", message: "This version was already decided." },
  claimed: { code: "claimed", message: "Another reviewer has claimed this version." },
  blocked: {
    code: "blocked",
    message: "The package is on the site skill blocklist: it can't be approved.",
  },
  block_verdict: {
    code: "block_verdict",
    message: "The scanner blocks this package: only a Site admin can approve it.",
  },
  own_submission: {
    code: "own_submission",
    message: "You submitted this version: another reviewer must decide it.",
  },
  confirmed_by_you: {
    code: "confirmed_by_you",
    message: "You confirmed this promotion as Team admin: another reviewer must approve it.",
  },
  scan_override_reason: {
    code: "scan_override_reason",
    message: "Approving over a Block verdict needs a note saying why.",
  },
  archived: {
    code: "archived",
    message: "The catalog skill is archived: nothing more is approved.",
  },
  submitter_deactivated: {
    code: "submitter_deactivated",
    message: "The submitter's account is deactivated: they can't become its maintainer.",
  },
} as const satisfies Record<string, Problem>;

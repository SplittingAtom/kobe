import { z } from "zod";

/**
 * Run states and the allowed transitions (spec §5.4 `runs.status`, D14, D17, D29, D30).
 * Pure data: the orchestrator (KOBE-30) and the `runs` table (KOBE-29) must use exactly this set.
 */
export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "budget_stopped",
] as const;

export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** A run in one of these states holds the thread's advisory lock (one active run per thread, D17). */
export const ACTIVE_RUN_STATUSES = ["running", "waiting_approval"] as const satisfies RunStatus[];

/** No transition leaves these. Retrying an `interrupted` run creates a new run (see below). */
export const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "budget_stopped",
] as const satisfies RunStatus[];

/** States in which `steer` is accepted (Pi queues it for the next safe point). */
export const STEERABLE_RUN_STATUSES = [
  "running",
  "waiting_approval",
] as const satisfies RunStatus[];

/** Only interrupted runs can be retried, manually (D14: never auto-retried). */
export const RETRYABLE_RUN_STATUSES = ["interrupted"] as const satisfies RunStatus[];

/** Why a transition happens; recorded with the transition for audit and tracing. */
export const RUN_TRANSITION_CAUSES = [
  "dequeued", // queued → running: thread lock acquired, sandbox reachable
  "approval_requested", // running → waiting_approval
  "approval_resolved", // waiting_approval → running: allow or deny fed back to Pi
  "approval_expired", // waiting_approval → failed: 1 h TTL, call denied, run ends visibly
  "settled", // running → completed: Pi `agent_settled`
  "error", // → failed: provider/Pi error, isolation runtime missing, sandbox could not start
  "sandbox_lost", // → interrupted: sandbox or Pi died mid-run
  "user_cancelled", // → cancelled: Stop, or a queued message deleted
  "budget_exhausted", // → budget_stopped: 100 % budget, after the current model step (D30)
] as const;
export const runTransitionCauseSchema = z.enum(RUN_TRANSITION_CAUSES);
export type RunTransitionCause = z.infer<typeof runTransitionCauseSchema>;

/**
 * The transition table. `RUN_TRANSITIONS[from][to]` lists the causes that may move a run from
 * `from` to `to`; an absent entry means the transition is forbidden.
 */
export const RUN_TRANSITIONS: Readonly<
  Record<RunStatus, Readonly<Partial<Record<RunStatus, readonly RunTransitionCause[]>>>>
> = {
  queued: {
    running: ["dequeued"],
    failed: ["error"],
    cancelled: ["user_cancelled"],
    budget_stopped: ["budget_exhausted"],
  },
  running: {
    waiting_approval: ["approval_requested"],
    completed: ["settled"],
    failed: ["error"],
    interrupted: ["sandbox_lost"],
    cancelled: ["user_cancelled"],
    budget_stopped: ["budget_exhausted"],
  },
  waiting_approval: {
    running: ["approval_resolved"],
    failed: ["approval_expired", "error"],
    interrupted: ["sandbox_lost"],
    cancelled: ["user_cancelled"],
    budget_stopped: ["budget_exhausted"],
  },
  completed: {},
  failed: {},
  interrupted: {},
  cancelled: {},
  budget_stopped: {},
};

export function canTransition(from: RunStatus, to: RunStatus, cause?: RunTransitionCause): boolean {
  const causes = RUN_TRANSITIONS[from][to];
  if (causes === undefined) return false;
  return cause === undefined || causes.includes(cause);
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

export function isActiveRunStatus(status: RunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

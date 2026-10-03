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

/**
 * Thread status (`threads.status`, KOBE-29 enum) and the queue rule (D14, D17).
 *
 * - A thread is `running` while one of its runs is active, `interrupted` after its active run was
 *   interrupted, `idle` otherwise.
 * - **`interrupted` blocks the queue:** queued runs do not auto-start after an interrupted run
 *   ("Retry from last entry" must be able to run first, and side effects may already have happened).
 *   The user resolves it with Retry (the retry run starts at once, ahead of the queue; the queue
 *   resumes after it ends) or with "Continue without retry" (`resumeQueue`, thread → idle, queue
 *   resumes). New messages on an interrupted thread queue.
 * - After `completed`, `failed`, `cancelled` the next queued run starts (Stop leaves queued messages
 *   in place, D17). Budget stops end queued runs too (`budget_stopped`).
 */
export const THREAD_STATUSES = ["idle", "running", "interrupted"] as const;
export const threadStatusSchema = z.enum(THREAD_STATUSES);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;

export type ThreadStatusEvent =
  | {
      readonly kind: "run_status";
      readonly to: RunStatus;
      /** Whether the run held the thread (was `running`/`waiting_approval`) before this change. */
      readonly was_active: boolean;
    }
  | { readonly kind: "queue_resumed" };

export function nextThreadStatus(current: ThreadStatus, event: ThreadStatusEvent): ThreadStatus {
  if (event.kind === "queue_resumed") return current === "interrupted" ? "idle" : current;
  if (isActiveRunStatus(event.to)) return "running";
  if (!isTerminalRunStatus(event.to) || !event.was_active) return current;
  return event.to === "interrupted" ? "interrupted" : "idle";
}

/** Whether the orchestrator may start the thread's next queued run now. */
export function queueMayAdvance(status: ThreadStatus): boolean {
  return status === "idle";
}

/**
 * Retry rules (D14, KOBE-26): only the thread's **latest run that ran** (ended, and
 * `started_at` not null), only if `interrupted`, at most once (`runs.retry_of_run_id`, unique
 * index). Runs that ended without ever starting (a deleted or failed queued message) are skipped:
 * they never ran, so they cannot hide an interrupted run from Retry. A repeated retry of the same
 * run returns the existing retry run (idempotent) instead of creating another.
 */
export type RetryCheck = "ok" | "already_retried" | "not_interrupted" | "not_latest";

export interface RetryCandidate {
  readonly run_id: string;
  readonly status: RunStatus;
  readonly retry_of_run_id?: string | undefined;
  /**
   * `runs.started_at`; `null` = never started (skipped by the "latest" rule). Omitted = unknown,
   * treated as started (callers that pre-filter never-started runs, as before this field).
   */
  readonly started_at?: string | null | undefined;
}

/** `runs` is the thread's runs in creation order. */
export function checkRetry(runs: readonly RetryCandidate[], runId: string): RetryCheck {
  if (runs.some((r) => r.retry_of_run_id === runId)) return "already_retried";
  const target = runs.find((r) => r.run_id === runId);
  if (target?.status !== "interrupted") return "not_interrupted";
  const latestEnded = runs
    .filter((r) => isTerminalRunStatus(r.status) && r.started_at !== null)
    .at(-1);
  return latestEnded?.run_id === runId ? "ok" : "not_latest";
}

import { z } from "zod";
import {
  approvalModeSchema,
  idSchema,
  runTriggerSchema,
  timestampSchema,
  type ActorContext,
  type ApprovalMode,
  type RunTrigger,
} from "./common.js";
import { runStatusSchema, type RunStatus, type RunTransitionCause } from "./runs.js";

/**
 * Run orchestrator contract (KOBE-30 implements; consumed by API routes KOBE-34/32, retry KOBE-26,
 * budgets KOBE-42, scheduler KOBE-64, tracing KOBE-10). Types only — no behaviour lives here.
 *
 * Invariants every implementation keeps:
 * - One active run (`running` | `waiting_approval`) per thread, enforced with a Postgres advisory
 *   lock across replicas (D17). Other submissions queue in `queue_pos` order.
 * - Every status change follows `RUN_TRANSITIONS` (runs.ts) and is written in the same transaction
 *   as its Kobe Event Stream event (`run.*`) in `run_events`.
 * - All calls run under `withTeam(actor.team_id)`; a run of another team is "not found".
 * - Interrupted runs are never retried automatically (D14).
 */

/** Message content as submitted (§6.1 `POST /v1/threads/{id}/messages`). */
export const submitMessageBodySchema = z.object({
  parent_entry_id: idSchema.optional(),
  content: z.string().min(1).max(200_000),
  file_ids: z.array(idSchema).max(100).optional(),
});
export type SubmitMessageBody = z.infer<typeof submitMessageBodySchema>;

/** §6.1 response: `queued` is true when another run was active and this one waits. */
export const submitMessageResultSchema = z.object({
  run_id: idSchema,
  queued: z.boolean(),
});
export type SubmitMessageResult = z.infer<typeof submitMessageResultSchema>;

/** §6.1 `POST /v1/runs/{id}/steer`. */
export const steerBodySchema = z.object({
  content: z.string().min(1).max(200_000),
});
export type SteerBody = z.infer<typeof steerBodySchema>;

/** Editing a queued message (D17: queued messages are editable or deletable). */
export const updateQueuedBodySchema = steerBodySchema;
export type UpdateQueuedBody = SteerBody;

/** Public view of a run (API responses and orchestrator return values). */
export const runSnapshotSchema = z.object({
  run_id: idSchema,
  thread_id: idSchema,
  team_id: idSchema,
  status: runStatusSchema,
  trigger: runTriggerSchema,
  /** Position among the thread's queued runs (1 = next); absent unless `queued`. */
  queue_pos: z.number().int().positive().optional(),
  /** Set when this run retries an interrupted run (KOBE-26). */
  retry_of_run_id: idSchema.optional(),
  /** The user entry this run answers. */
  user_entry_id: idSchema.optional(),
  approval_mode: approvalModeSchema,
  started_at: timestampSchema.optional(),
  ended_at: timestampSchema.optional(),
});
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

export interface SubmitMessageCommand extends SubmitMessageBody {
  readonly thread_id: string;
  readonly trigger: RunTrigger;
  /**
   * Scheduled runs (D32) always run in `auto`; user runs use the thread's mode. The orchestrator
   * may only make it stricter than the policy floor, never looser.
   */
  readonly approval_mode?: ApprovalMode;
}

/** How a budget stop is applied (D30): finish the in-flight model step, then end. */
export interface BudgetStopCommand {
  readonly team_id: string;
  /** Limit the stop to one user's runs (user-in-team budget); absent = whole team. */
  readonly user_id?: string;
  readonly scope: "install" | "team" | "user";
}

export interface RunTransition {
  readonly run: RunSnapshot;
  readonly from: RunStatus;
  readonly to: RunStatus;
  readonly cause: RunTransitionCause;
  readonly at: string;
}

export type RunTransitionListener = (transition: RunTransition) => void;

/** Error codes an orchestrator rejects with. Routes map them to HTTP statuses. */
export const RUN_ERROR_CODES = [
  "run_not_found", // 404 (also for another team's run)
  "thread_not_found", // 404
  "forbidden", // 403
  "invalid_transition", // 409: e.g. steer on a completed run, retry on a failed one
  "budget_exhausted", // 402/429: new runs are blocked at 100 % (D30)
  "isolation_unavailable", // 503: no gVisor/Kata RuntimeClass (D4)
] as const;
export type RunErrorCode = (typeof RUN_ERROR_CODES)[number];

export interface RunOrchestrator {
  /** Start a run now, or queue it behind the thread's active run (D17). */
  submitMessage(actor: ActorContext, command: SubmitMessageCommand): Promise<SubmitMessageResult>;
  /** Inject into the active run at Pi's next safe point. Rejects unless running/waiting_approval. */
  steer(actor: ActorContext, runId: string, body: SteerBody): Promise<RunSnapshot>;
  /** Stop: running → cancelled (Pi `abort`); queued → cancelled (deletes the queued message). */
  cancel(actor: ActorContext, runId: string): Promise<RunSnapshot>;
  /** Edit a queued message's content. Rejects unless `queued`. */
  updateQueued(actor: ActorContext, runId: string, body: UpdateQueuedBody): Promise<RunSnapshot>;
  /** Manual "Retry from last entry" (D14): creates a new run with `retry_of_run_id`. */
  retry(actor: ActorContext, runId: string): Promise<SubmitMessageResult>;
  getRun(actor: ActorContext, runId: string): Promise<RunSnapshot>;
  /** The thread's active run (if any) followed by queued runs in order. */
  listThreadRuns(actor: ActorContext, threadId: string): Promise<readonly RunSnapshot[]>;

  // --- Internal entry points (not exposed over HTTP) ---------------------------------------------

  /** KOBE-42: apply a budget stop to matching active and queued runs; returns affected run ids. */
  stopForBudget(command: BudgetStopCommand): Promise<readonly string[]>;
  /** KOBE-24/25/26: the sandbox's socket or Pi process is gone; interrupt its active runs. */
  markSandboxLost(teamId: string, sandboxId: string): Promise<readonly string[]>;
  /** KOBE-10 (tracing), KOBE-64 (schedules): observe transitions. Returns an unsubscribe. */
  onTransition(listener: RunTransitionListener): () => void;
}

import {
  isActiveRunStatus,
  queueMayAdvance,
  type ApprovalMode,
  type ErrorInfo,
  type PiThreadConfig,
} from "@kobe/protocol";
import type { KobeTx } from "@kobe/db";
import type { NewRunEvent } from "../event-stream/append.js";
import { clampApprovalMode } from "../sandbox-wire/policy-check.js";
import {
  applyTransition,
  lockThreadRow,
  principalActive,
  threadRunRows,
  type AppliedTransition,
  type RunRow,
  type ThreadRow,
} from "./store.js";
import type { RunAgentResolver } from "./seams.js";

/** Everything a replica needs to send `run.start` for a run it just moved to `running`. */
export interface StartPlan {
  readonly teamId: string;
  readonly runId: string;
  readonly threadId: string;
  /** The sandbox is the thread owner's (D11: one sandbox per user and team). */
  readonly ownerUserId: string;
  readonly input: string;
  readonly parentEntryId: string | null;
  readonly approvalMode: ApprovalMode;
  readonly agent: { readonly agentId: string; readonly version: number } | null;
  readonly config?: Omit<PiThreadConfig, "agent" | "approval_mode">;
}

export interface Promotion {
  readonly plan?: StartPlan;
  readonly transitions: readonly AppliedTransition[];
}

/** Codes of `run.failed` the orchestrator writes itself; anything else becomes `start_failed`. */
const FAILURE_MESSAGES: Record<string, string> = {
  account_inactive: "The run could not start: the account is deactivated or no longer in the team.",
  agent_unavailable: "The run could not start: the thread's agent version is not available.",
  timeout: "Your workspace did not answer in time, so the run could not start.",
  thread_not_found: "The run could not start: the thread is not available to the workspace.",
  start_lost: "The run could not start: the server that started it stopped. Send it again.",
  start_failed: "The run could not start in your workspace.",
};

/**
 * A `run.failed` event with a message of the server's own: the sandbox's text is untrusted and is
 * never shown to the user (only logged by the caller).
 */
export function failedEvent(code: string): NewRunEvent {
  const message = FAILURE_MESSAGES[code];
  const error: ErrorInfo =
    message === undefined
      ? { code: "start_failed", message: FAILURE_MESSAGES.start_failed ?? "" }
      : { code, message };
  return { type: "run.failed", payload: { error } };
}

/** The terminal event of a Stop (§6.2 has no `run.cancelled`: the contract uses this). */
export function cancelledEvent(thread: ThreadRow): NewRunEvent {
  return {
    type: "run.interrupted",
    payload: { reason: "cancelled", last_entry_id: thread.leafEntryId, retryable: false },
  };
}

export function budgetStoppedEvent(scope: "install" | "team" | "user"): NewRunEvent {
  const whose = scope === "user" ? "your" : scope === "team" ? "the team's" : "the install's";
  return {
    type: "run.budget_stopped",
    payload: { scope, message: `The run stopped because ${whose} budget is used up.` },
  };
}

/** Bound on queued runs inspected per promotion (each failure moves on to the next). */
const MAX_PROMOTION_STEPS = 64;

/**
 * Starts the thread's next run if it may start now (D14, D17): no active run, not in Trash, and the
 * queue may advance (`queueMayAdvance`) — except a retry, which starts ahead of the queue even on
 * an interrupted thread. The run moves `queued → running` with `run.started`, its branch point
 * fixed (requested parent, else the thread's leaf), its agent version resolved and its mode
 * tightened by the resolver (KOBE-46/47). A run that can't start (owner deactivated or removed,
 * agent unavailable) fails visibly and the next one is tried. Locks the thread first.
 */
export async function promoteInTx(
  tx: KobeTx,
  agents: RunAgentResolver,
  teamId: string,
  threadId: string,
): Promise<Promotion> {
  const transitions: AppliedTransition[] = [];
  let thread = await lockThreadRow(tx, teamId, threadId);
  if (!thread || thread.deletedAt !== null) return { transitions };
  const fail = async (t: ThreadRow, run: RunRow, code: string): Promise<ThreadRow> => {
    const applied = await applyTransition(tx, t, run, "failed", "error", failedEvent(code));
    transitions.push(applied.transition);
    return { ...t, status: applied.threadStatus };
  };
  for (let step = 0; step < MAX_PROMOTION_STEPS; step += 1) {
    const rows = await threadRunRows(tx, teamId, threadId);
    if (rows.some((r) => isActiveRunStatus(r.status))) return { transitions };
    const next = rows.find((r) => r.status === "queued");
    if (!next) return { transitions };
    if (next.retryOfRunId === null && !queueMayAdvance(thread.status)) return { transitions };
    if (!(await principalActive(tx, teamId, thread.ownerUserId))) {
      // The owner can't run anything (KOBE-13): their queued messages fail visibly.
      for (const queued of rows.filter((r) => r.status === "queued")) {
        thread = await fail(thread, queued, "account_inactive");
      }
      return { transitions };
    }
    const resolved = await agents.resolve(tx, {
      teamId,
      ownerUserId: thread.ownerUserId,
      threadId,
      runId: next.id,
      trigger: next.trigger,
      agentId: thread.agentId,
      agentVersion: thread.agentVersion,
      approvalMode: next.approvalMode,
    });
    if (!resolved.ok) {
      thread = await fail(thread, next, "agent_unavailable");
      continue;
    }
    // The resolver may only tighten the mode fixed at creation.
    const approvalMode = clampApprovalMode(resolved.approvalMode, next.approvalMode);
    const parentEntryId = next.parentEntryId ?? thread.leafEntryId;
    const started: NewRunEvent = {
      type: "run.started",
      payload: {
        thread_id: threadId,
        agent_id: resolved.agent?.agentId ?? null,
        agent_version: resolved.agent?.version ?? null,
        ...(next.retryOfRunId !== null ? { retry_of_run_id: next.retryOfRunId } : {}),
      },
    };
    const applied = await applyTransition(tx, thread, next, "running", "dequeued", started, {
      parentEntryId,
      approvalMode,
    });
    transitions.push(applied.transition);
    return {
      transitions,
      plan: {
        teamId,
        runId: next.id,
        threadId,
        ownerUserId: thread.ownerUserId,
        input: next.input,
        parentEntryId,
        approvalMode,
        agent: resolved.agent,
        ...(resolved.config !== undefined ? { config: resolved.config } : {}),
      },
    };
  }
  return { transitions };
}

import {
  canTransition,
  nextThreadStatus,
  type RunStatus,
  type RunTransitionCause,
  type ServerCallPurpose,
  type ThreadStatus,
} from "@kobe/protocol";
import { SYSTEM_ACTOR, readBudgetStopScope, sql, type KobeTx, type RunKind } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { auditExpiredApprovals, expireRunApprovalsInTx } from "../approvals/run-end.js";
import { appendRunEventsInTx, type NewRunEvent } from "../event-stream/append.js";
import { notifyScheduledRunEndInTx } from "../notifications/record.js";
import { reportSkippedActionsInTx } from "../policy/skipped-summary.js";
import { failureInfo } from "../runs/failure-codes.js";
import { keepPromptAtEndInTx, type PromptSource } from "../runs/run-prompt.js";
import { wantsTitleInTx } from "../threads/title.js";
import type { RunEnd } from "./types.js";

/** Why the wire interrupted a run (audit `run.interrupted.cause`). */
export type InterruptCause = "sandbox_gone" | "not_resumed" | "pi_exited";

export interface RunRow {
  readonly status: RunStatus;
  readonly threadId: string;
  readonly trigger: "user" | "schedule";
  readonly sandboxSeq: number;
  readonly ownerUserId: string;
}

/** The run with its thread's owner (under the team's RLS); undefined when not in this team. */
export async function loadRun(
  tx: KobeTx,
  teamId: string,
  runId: string,
): Promise<RunRow | undefined> {
  const res = await tx.execute<{
    status: RunStatus;
    thread_id: string;
    trigger: "user" | "schedule";
    sandbox_seq: number;
    owner_user_id: string;
  }>(sql`
    SELECT r.status, r.thread_id, r.trigger, r.sandbox_seq, t.owner_user_id
      FROM runs r JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
     WHERE r.team_id = ${teamId} AND r.id = ${runId}`);
  const row = res.rows[0];
  return row
    ? {
        status: row.status,
        threadId: row.thread_id,
        trigger: row.trigger,
        sandboxSeq: row.sandbox_seq,
        ownerUserId: row.owner_user_id,
      }
    : undefined;
}

const CAUSE: Record<RunEnd["status"], RunTransitionCause> = {
  completed: "settled",
  failed: "error",
  interrupted: "sandbox_lost",
};

type BudgetScope = "site" | "team" | "user";

/** The terminal event of a budget stop (D30); same text as the orchestrator's. */
function budgetStoppedEvent(scope: BudgetScope): NewRunEvent {
  const whose = scope === "user" ? "your" : scope === "team" ? "the team's" : "the site's";
  return {
    type: "run.budget_stopped",
    payload: { scope, message: `The run stopped because ${whose} budget is used up.` },
  };
}

function terminalEvent(
  end: RunEnd,
  leaf: string | null,
  epilogue: readonly ServerCallPurpose[],
): NewRunEvent {
  switch (end.status) {
    case "completed":
      return {
        type: "run.completed",
        payload: { leaf_entry_id: leaf, ...(epilogue.length > 0 ? { epilogue } : {}) },
      };
    case "failed":
      return { type: "run.failed", payload: { error: end.error } };
    case "interrupted":
      return {
        type: "run.interrupted",
        payload: { reason: "sandbox_lost", last_entry_id: leaf, retryable: true },
      };
  }
}

/**
 * Ends an active run the way the run contract requires (KOBE-29/31, `RUN_TRANSITIONS`): thread row
 * locked first, then the run; the terminal status, the thread status (`nextThreadStatus`) and the
 * terminal event in one transaction, the event last. Returns false when the run is no longer
 * active or the transition is not allowed (e.g. Stop got there first): nothing is written.
 *
 * Pending approvals of the run expire first (KOBE-37: `approval.resolved` before the terminal
 * event). A run Pi settled while an approval was still pending in Postgres (its waiter's replica
 * died; the sandbox had already denied the call locally) completes from `waiting_approval`.
 */
export async function endRunInTx(
  tx: KobeTx,
  teamId: string,
  runId: string,
  requested: RunEnd,
  interruptCause?: InterruptCause,
  /** What Pi has of the run's prompt, when the caller read it (KOBE-290; else: leased or not). */
  prompt?: PromptSource,
  /** Server calls this server can make after a completed message run (KOBE-234/219). */
  serverCalls: readonly ServerCallPurpose[] = [],
): Promise<{ ended: boolean; threadId?: string }> {
  let end = requested;
  const head = await tx.execute<{ thread_id: string }>(sql`
    SELECT thread_id FROM runs WHERE team_id = ${teamId} AND id = ${runId}`);
  const threadId = head.rows[0]?.thread_id;
  if (threadId === undefined) return { ended: false };
  const thread = await tx.execute<{ status: ThreadStatus; leaf_entry_id: string | null }>(sql`
    SELECT status, leaf_entry_id FROM threads
     WHERE team_id = ${teamId} AND id = ${threadId} FOR NO KEY UPDATE`);
  const run = await tx.execute<{
    status: RunStatus;
    budget_stop_scope: string | null;
    trigger: "user" | "schedule";
    kind: RunKind;
  }>(sql`
    SELECT status, budget_stop_scope, trigger, kind FROM runs
     WHERE team_id = ${teamId} AND id = ${runId} FOR NO KEY UPDATE`);
  const from = run.rows[0]?.status;
  const threadRow = thread.rows[0];
  if (from === undefined || threadRow === undefined) return { ended: false };
  // A compaction (KOBE-213) is never retried: a lost one fails, and the thread goes back to idle
  // instead of waiting on Retry. Pi keeps its session; a summary it still wrote is mirrored later.
  if (run.rows[0]?.kind === "compaction" && end.status === "interrupted") {
    end = { status: "failed", error: failureInfo("compaction_interrupted", "start_failed") };
  }
  // A budget stop is pending (KOBE-30/42): Pi settling after the step ends the run budget_stopped,
  // and so does a run whose next model call the gateway's budget gate refused before the stop
  // reached Pi (`model_budget_exhausted`). Any other failure keeps its own code.
  const budgetScope = readBudgetStopScope(run.rows[0]?.budget_stop_scope ?? null);
  const budgetEnded =
    end.status === "completed" ||
    (end.status === "failed" && end.error.code === "model_budget_exhausted");
  const to: RunStatus = budgetScope && budgetEnded ? "budget_stopped" : end.status;
  const cause = to === "budget_stopped" ? "budget_exhausted" : CAUSE[end.status];
  const settledWhileWaiting = from === "waiting_approval" && to === "completed";
  if (!canTransition(settledWhileWaiting ? "running" : from, to, cause)) {
    return { ended: false, threadId };
  }
  const expired = await expireRunApprovalsInTx(tx, teamId, runId, expiryCauseOfEnd(to));
  await tx.execute(sql`
    UPDATE runs SET status = ${to}, ended_at = now()
     WHERE team_id = ${teamId} AND id = ${runId}`);
  // The run's gateway tokens are revoked by the `runs_revoke_run_tokens` trigger (KOBE-118).
  const nextStatus = nextThreadStatus(threadRow.status, {
    kind: "run_status",
    to,
    was_active: true,
  });
  if (nextStatus !== threadRow.status) {
    await tx.execute(sql`
      UPDATE threads SET status = ${nextStatus}, last_activity_at = now()
       WHERE team_id = ${teamId} AND id = ${threadId}`);
  }
  const terminal =
    budgetScope && to === "budget_stopped"
      ? budgetStoppedEvent(budgetScope)
      : terminalEvent(
          end,
          threadRow.leaf_entry_id,
          to === "completed" ? await epilogueOf(tx, teamId, runId, threadId, serverCalls) : [],
        );
  // A message whose run ends before Pi's first turn_end stays in the conversation (KOBE-290).
  const kept = to === "completed" ? [] : await keepPromptAtEndInTx(tx, teamId, runId, prompt);
  // A scheduled run's denied calls (D32) are reported on its terminal event and in its thread.
  await appendRunEventsInTx(tx, teamId, runId, [
    ...kept,
    await reportSkippedActionsInTx(
      tx,
      { teamId, runId, threadId },
      terminal,
      run.rows[0]?.trigger === "schedule",
    ),
  ]);
  // The owner hears about a scheduled run's end in the same transaction (D32, KOBE-179).
  await notifyScheduledRunEndInTx(tx, {
    teamId,
    runId,
    threadId,
    trigger: run.rows[0]?.trigger ?? "user",
    to,
  });
  if (budgetScope && to === "budget_stopped") {
    await recordAudit(tx, {
      action: "run.budget_stopped",
      actor: SYSTEM_ACTOR,
      teamId,
      target: { runId, threadId, scope: budgetScope },
    });
  }
  // A compaction ended by its sandbox going away (KOBE-213) is audited as one too.
  if (requested.status === "interrupted" && run.rows[0]?.kind === "compaction") {
    await recordAudit(tx, {
      action: "thread.compacted",
      actor: SYSTEM_ACTOR,
      teamId,
      target: { threadId, runId, outcome: "interrupted" },
    });
  }
  if (requested.status === "interrupted") {
    await recordAudit(tx, {
      action: "run.interrupted",
      actor: SYSTEM_ACTOR,
      teamId,
      target: { runId, threadId, cause: interruptCause ?? "sandbox_gone" },
    });
  }
  await auditExpiredApprovals(tx, teamId, expired);
  return { ended: true, threadId };
}

/**
 * What `run.completed` announces (KOBE-234 Flow 1): only calls this server can make and the run
 * qualifies for. Decided here, in the transaction that completes the run, so a stream that sees
 * the terminal event knows whether to wait.
 */
async function epilogueOf(
  tx: KobeTx,
  teamId: string,
  runId: string,
  threadId: string,
  serverCalls: readonly ServerCallPurpose[],
): Promise<ServerCallPurpose[]> {
  if (!serverCalls.includes("title")) return [];
  return (await wantsTitleInTx(tx, teamId, runId, threadId)) ? ["title"] : [];
}

function expiryCauseOfEnd(to: RunStatus) {
  if (to === "budget_stopped") return "budget_exhausted" as const;
  if (to === "failed") return "run_failed" as const;
  return "run_interrupted" as const;
}

/**
 * The run is an active message run of this thread (KOBE-213): what a tool frame may name. Read
 * from the database, so a compaction is refused even if a lease's in-memory flag were wrong.
 */
export async function isActiveMessageRun(
  tx: KobeTx,
  teamId: string,
  runId: string,
  threadId: string,
): Promise<boolean> {
  const res = await tx.execute<{ ok: boolean }>(sql`
    SELECT kind = 'message' AND status IN ('running', 'waiting_approval') AS ok
      FROM runs WHERE team_id = ${teamId} AND id = ${runId} AND thread_id = ${threadId}`);
  return res.rows[0]?.ok === true;
}

export interface LeasedRun {
  readonly runId: string;
  readonly threadId: string;
  readonly status: RunStatus;
  readonly sandboxSeq: number;
  /** A compaction (KOBE-213) is never resumed on a new connection: its command died with the old. */
  readonly kind: RunKind;
}

/** Runs leased to the (team, user) sandbox that are still active. */
export async function activeLeasedRuns(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<LeasedRun[]> {
  const res = await tx.execute<{
    run_id: string;
    thread_id: string;
    status: RunStatus;
    sandbox_seq: number;
    kind: RunKind;
  }>(sql`
    SELECT l.run_id, l.thread_id, r.status, r.sandbox_seq, r.kind
      FROM sandbox_run_leases l
      JOIN runs r ON r.team_id = l.team_id AND r.id = l.run_id
     WHERE l.team_id = ${teamId} AND l.user_id = ${userId}
       AND r.status IN ('running', 'waiting_approval')`);
  return res.rows.map((r) => ({
    runId: r.run_id,
    threadId: r.thread_id,
    status: r.status,
    sandboxSeq: r.sandbox_seq,
    kind: r.kind,
  }));
}

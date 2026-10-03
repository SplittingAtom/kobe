import {
  canTransition,
  nextThreadStatus,
  type RunStatus,
  type RunTransitionCause,
  type ThreadStatus,
} from "@kobe/protocol";
import { SYSTEM_ACTOR, sql, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { appendRunEventsInTx, type NewRunEvent } from "../event-stream/append.js";
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

type BudgetScope = "install" | "team" | "user";

/** The terminal event of a budget stop (D30); same text as the orchestrator's. */
function budgetStoppedEvent(scope: BudgetScope): NewRunEvent {
  const whose = scope === "user" ? "your" : scope === "team" ? "the team's" : "the install's";
  return {
    type: "run.budget_stopped",
    payload: { scope, message: `The run stopped because ${whose} budget is used up.` },
  };
}

function terminalEvent(end: RunEnd, leaf: string | null): NewRunEvent {
  switch (end.status) {
    case "completed":
      return { type: "run.completed", payload: { leaf_entry_id: leaf } };
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
 * Pending approvals of the run (KOBE-37) must expire with an `approval.resolved` event before the
 * terminal event; there is no approvals table yet, so KOBE-37 adds that step here.
 */
export async function endRunInTx(
  tx: KobeTx,
  teamId: string,
  runId: string,
  end: RunEnd,
  interruptCause?: InterruptCause,
): Promise<{ ended: boolean; threadId?: string }> {
  const head = await tx.execute<{ thread_id: string }>(sql`
    SELECT thread_id FROM runs WHERE team_id = ${teamId} AND id = ${runId}`);
  const threadId = head.rows[0]?.thread_id;
  if (threadId === undefined) return { ended: false };
  const thread = await tx.execute<{ status: ThreadStatus; leaf_entry_id: string | null }>(sql`
    SELECT status, leaf_entry_id FROM threads
     WHERE team_id = ${teamId} AND id = ${threadId} FOR NO KEY UPDATE`);
  const run = await tx.execute<{ status: RunStatus; budget_stop_scope: BudgetScope | null }>(sql`
    SELECT status, budget_stop_scope FROM runs
     WHERE team_id = ${teamId} AND id = ${runId} FOR NO KEY UPDATE`);
  const from = run.rows[0]?.status;
  const threadRow = thread.rows[0];
  if (from === undefined || threadRow === undefined) return { ended: false };
  // A budget stop is pending (KOBE-30/42): Pi settling after the step ends the run budget_stopped.
  const budgetScope = run.rows[0]?.budget_stop_scope ?? null;
  const to: RunStatus = end.status === "completed" && budgetScope ? "budget_stopped" : end.status;
  const cause = to === "budget_stopped" ? "budget_exhausted" : CAUSE[end.status];
  if (!canTransition(from, to, cause)) return { ended: false, threadId };
  await tx.execute(sql`
    UPDATE runs SET status = ${to}, ended_at = now()
     WHERE team_id = ${teamId} AND id = ${runId}`);
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
  await appendRunEventsInTx(tx, teamId, runId, [
    budgetScope && to === "budget_stopped"
      ? budgetStoppedEvent(budgetScope)
      : terminalEvent(end, threadRow.leaf_entry_id),
  ]);
  if (budgetScope && to === "budget_stopped") {
    await recordAudit(tx, {
      action: "run.budget_stopped",
      actor: SYSTEM_ACTOR,
      teamId,
      target: { runId, threadId, scope: budgetScope },
    });
  }
  if (end.status === "interrupted") {
    await recordAudit(tx, {
      action: "run.interrupted",
      actor: SYSTEM_ACTOR,
      teamId,
      target: { runId, threadId, cause: interruptCause ?? "sandbox_gone" },
    });
  }
  return { ended: true, threadId };
}

export interface LeasedRun {
  readonly runId: string;
  readonly threadId: string;
  readonly status: RunStatus;
  readonly sandboxSeq: number;
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
  }>(sql`
    SELECT l.run_id, l.thread_id, r.status, r.sandbox_seq
      FROM sandbox_run_leases l
      JOIN runs r ON r.team_id = l.team_id AND r.id = l.run_id
     WHERE l.team_id = ${teamId} AND l.user_id = ${userId}
       AND r.status IN ('running', 'waiting_approval')`);
  return res.rows.map((r) => ({
    runId: r.run_id,
    threadId: r.thread_id,
    status: r.status,
    sandboxSeq: r.sandbox_seq,
  }));
}

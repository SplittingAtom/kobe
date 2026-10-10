import {
  canTransition,
  isActiveRunStatus,
  isTerminalRunStatus,
  nextThreadStatus,
  type ApprovalMode,
  type RunSnapshot,
  type RunStatus,
  type RunTransitionCause,
  type RunTrigger,
  type ThreadStatus,
} from "@kobe/protocol";
import { sql, type AgentScope, type KobeTx } from "@kobe/db";
import {
  auditExpiredApprovals,
  expireRunApprovalsInTx,
  expiryCauseOf,
} from "../approvals/run-end.js";
import { appendRunEventsInTx, type NewRunEvent } from "../event-stream/append.js";
import { THREAD_LOCK_TIMEOUT } from "../threads/repository.js";
import { RunError } from "./errors.js";

/**
 * Run rows and the thread lock (KOBE-30). Everything here runs inside the caller's `withTeam`
 * transaction and carries explicit `team_id` predicates (RLS is the wall; the predicate leads the
 * index). Lock order is always thread row → run row (KOBE-29), and every status change writes the
 * run, the thread status (`nextThreadStatus`) and the `run.*` event in the same transaction
 * (KOBE-31).
 */

export interface RunRow {
  readonly id: string;
  readonly teamId: string;
  readonly threadId: string;
  readonly status: RunStatus;
  readonly trigger: RunTrigger;
  readonly queuePos: number | null;
  readonly retryOfRunId: string | null;
  readonly userEntryId: string | null;
  readonly approvalMode: ApprovalMode;
  readonly input: string;
  readonly parentEntryId: string | null;
  readonly budgetStopScope: "install" | "team" | "user" | null;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  /** 1-based position among the thread's queued runs (retries first); null unless queued. */
  readonly queueRank: number | null;
}

type RawRun = {
  id: string;
  team_id: string;
  thread_id: string;
  status: RunStatus;
  trigger: RunTrigger;
  queue_pos: number | null;
  retry_of_run_id: string | null;
  user_entry_id: string | null;
  approval_mode: ApprovalMode;
  input: string;
  parent_entry_id: string | null;
  budget_stop_scope: "install" | "team" | "user" | null;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  queue_rank: string | number | null;
};

const asDate = (v: Date | string | null): Date | null =>
  v === null ? null : v instanceof Date ? v : new Date(v);

function fromRaw(r: RawRun): RunRow {
  return {
    id: r.id,
    teamId: r.team_id,
    threadId: r.thread_id,
    status: r.status,
    trigger: r.trigger,
    queuePos: r.queue_pos,
    retryOfRunId: r.retry_of_run_id,
    userEntryId: r.user_entry_id,
    approvalMode: r.approval_mode,
    input: r.input,
    parentEntryId: r.parent_entry_id,
    budgetStopScope: r.budget_stop_scope,
    startedAt: asDate(r.started_at),
    endedAt: asDate(r.ended_at),
    queueRank: r.queue_rank === null ? null : Number(r.queue_rank),
  };
}

/**
 * Queue order: retries first (D14: "Retry runs first"), then `queue_pos`. The rank is computed, not
 * stored, so dequeuing or cancelling never renumbers rows (KOBE-29: `queue_pos` is unique among a
 * thread's queued runs).
 */
const RUN_SELECT = sql`
  SELECT r.id, r.team_id, r.thread_id, r.status, r.trigger, r.queue_pos, r.retry_of_run_id,
         r.user_entry_id, r.approval_mode, r.input, r.parent_entry_id, r.budget_stop_scope,
         r.started_at, r.ended_at,
         CASE WHEN r.status = 'queued' THEN (
           SELECT count(*) FROM runs q
            WHERE q.team_id = r.team_id AND q.thread_id = r.thread_id AND q.status = 'queued'
              AND (q.retry_of_run_id IS NULL, q.queue_pos) <= (r.retry_of_run_id IS NULL, r.queue_pos)
         ) END AS queue_rank
    FROM runs r`;

export function toSnapshot(run: RunRow): RunSnapshot {
  return {
    run_id: run.id,
    thread_id: run.threadId,
    team_id: run.teamId,
    status: run.status,
    trigger: run.trigger,
    approval_mode: run.approvalMode,
    ...(run.queueRank !== null ? { queue_pos: run.queueRank } : {}),
    ...(run.retryOfRunId !== null ? { retry_of_run_id: run.retryOfRunId } : {}),
    ...(run.userEntryId !== null ? { user_entry_id: run.userEntryId } : {}),
    ...(run.startedAt !== null ? { started_at: run.startedAt.toISOString() } : {}),
    ...(run.endedAt !== null ? { ended_at: run.endedAt.toISOString() } : {}),
  };
}

export async function getRunRow(
  tx: KobeTx,
  teamId: string,
  runId: string,
): Promise<RunRow | undefined> {
  const res = await tx.execute<RawRun>(sql`${RUN_SELECT}
     WHERE r.team_id = ${teamId} AND r.id = ${runId}`);
  const row = res.rows[0];
  return row ? fromRaw(row) : undefined;
}

/** Locks the run row (after its thread's row) and returns it. */
export async function lockRunRow(
  tx: KobeTx,
  teamId: string,
  runId: string,
): Promise<RunRow | undefined> {
  await tx.execute(sql`
    SELECT 1 FROM runs WHERE team_id = ${teamId} AND id = ${runId} FOR NO KEY UPDATE`);
  return getRunRow(tx, teamId, runId);
}

/** The thread's active run (if any), then its queued runs in start order. */
export async function threadRunRows(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<RunRow[]> {
  const res = await tx.execute<RawRun>(sql`${RUN_SELECT}
     WHERE r.team_id = ${teamId} AND r.thread_id = ${threadId}
       AND r.status IN ('running', 'waiting_approval', 'queued')
     ORDER BY r.status = 'queued', r.retry_of_run_id IS NULL, r.queue_pos`);
  return res.rows.map(fromRaw);
}

/** Every run of a thread in creation order, as `checkRetry` needs them. */
export async function retryCandidates(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<{ run_id: string; status: RunStatus; retry_of_run_id?: string }[]> {
  // Runs that ended without ever starting (a deleted or failed queued message) are not "ended
  // runs" for Retry: they never ran, so they can't hide an interrupted run from it.
  const res = await tx.execute<{ id: string; status: RunStatus; retry_of_run_id: string | null }>(
    sql`
    SELECT id, status, retry_of_run_id FROM runs
     WHERE team_id = ${teamId} AND thread_id = ${threadId}
       AND (started_at IS NOT NULL OR status = 'queued')
     ORDER BY created_at, id`,
  );
  return res.rows.map((r) => ({
    run_id: r.id,
    status: r.status,
    ...(r.retry_of_run_id !== null ? { retry_of_run_id: r.retry_of_run_id } : {}),
  }));
}

// ------------------------------------------------------------------------------ the thread lock

export interface ThreadRow {
  readonly id: string;
  readonly ownerUserId: string;
  readonly status: ThreadStatus;
  readonly leafEntryId: string | null;
  readonly agentScope: AgentScope | null;
  readonly agentId: string | null;
  readonly agentVersion: number | null;
  readonly deletedAt: Date | null;
  /** The thread's chosen model alias (KOBE-44): the run's requested model; null = none chosen. */
  readonly modelAlias: string | null;
  /** The project the thread belongs to (KOBE-161): its instructions go to every run. */
  readonly projectId: string | null;
}

/** Fail fast instead of queueing behind a long-held thread row (KOBE-29/34: status writers). */
export async function setThreadLockTimeout(tx: KobeTx): Promise<void> {
  await tx.execute(sql`SELECT set_config('lock_timeout', ${THREAD_LOCK_TIMEOUT}, true)`);
}

/**
 * Locks the thread row by id (system paths: promotion, sweeps, wire hooks). The thread lock is the
 * per-thread mutex of D17 across replicas; the partial unique index `runs_one_active_per_thread`
 * backs it in the database.
 */
export async function lockThreadRow(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<ThreadRow | undefined> {
  const res = await tx.execute<{
    id: string;
    owner_user_id: string;
    status: ThreadStatus;
    leaf_entry_id: string | null;
    agent_scope: AgentScope | null;
    agent_id: string | null;
    agent_version: number | null;
    deleted_at: Date | string | null;
    model_alias: string | null;
    project_id: string | null;
  }>(sql`
    SELECT id, owner_user_id, status, leaf_entry_id, agent_scope, agent_id, agent_version,
           deleted_at, model_alias, project_id
      FROM threads WHERE team_id = ${teamId} AND id = ${threadId} FOR UPDATE`);
  const r = res.rows[0];
  return r
    ? {
        id: r.id,
        ownerUserId: r.owner_user_id,
        status: r.status,
        leafEntryId: r.leaf_entry_id,
        agentScope: r.agent_scope,
        agentId: r.agent_id,
        agentVersion: r.agent_version,
        deletedAt: asDate(r.deleted_at),
        modelAlias: r.model_alias,
        projectId: r.project_id,
      }
    : undefined;
}

/**
 * Whether the user may start or steer runs in the team (KOBE-13): account active and still a
 * member. `FOR SHARE` on the user row orders this against a concurrent deactivation.
 */
export async function principalActive(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<boolean> {
  const res = await tx.execute<{ deactivated_at: Date | null; role: string | null }>(sql`
    SELECT u.deactivated_at,
           (SELECT m.role FROM team_members m
             WHERE m.team_id = ${teamId} AND m.user_id = u.id) AS role
      FROM users u WHERE u.id = ${userId} FOR SHARE OF u`);
  const row = res.rows[0];
  return row !== undefined && row.deactivated_at === null && row.role !== null;
}

export async function entryExists(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  entryId: string,
): Promise<boolean> {
  const res = await tx.execute(sql`
    SELECT 1 FROM thread_entries
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND entry_id = ${entryId}`);
  return res.rows.length > 0;
}

/**
 * Stop pauses the queue (KOBE-26): stopping the active run while messages wait behind it leaves
 * them queued until the user resumes the queue or sends a new message. Thread row locked by the
 * caller.
 */
export async function setQueuePaused(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  paused: boolean,
): Promise<void> {
  await tx.execute(sql`
    UPDATE threads SET queue_paused_at = CASE WHEN ${paused} THEN now() END
     WHERE team_id = ${teamId} AND id = ${threadId}
       AND (queue_paused_at IS NULL) = ${paused}`);
}

/** Whether the thread's queue is paused by a Stop (see `setQueuePaused`). */
export async function isQueuePaused(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<boolean> {
  const res = await tx.execute<{ paused: boolean }>(sql`
    SELECT queue_paused_at IS NOT NULL AS paused
      FROM threads WHERE team_id = ${teamId} AND id = ${threadId}`);
  return res.rows[0]?.paused === true;
}

/**
 * A run of the thread that already ended but whose abort Pi has not confirmed yet (`stop_mode`
 * still set, KOBE-30 durable stop), requested less than `holdMs` ago. The sandbox agent refuses
 * a `run.start` on a thread whose Pi is still busy (`pi_rejected`), so the next start waits for
 * the abort — at most `holdMs` (the Stop grace), after which the queue moves anyway.
 */
export async function abortPending(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  holdMs: number,
): Promise<boolean> {
  const res = await tx.execute(sql`
    SELECT 1 FROM runs
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND stop_mode = 'abort'
       AND status NOT IN ('queued', 'running', 'waiting_approval')
       AND stop_requested_at > now() - make_interval(secs => ${holdMs / 1000})
     LIMIT 1`);
  return res.rows.length > 0;
}

export async function queuedCount(tx: KobeTx, teamId: string, threadId: string): Promise<number> {
  const res = await tx.execute<{ n: string | number }>(sql`
    SELECT count(*) AS n FROM runs
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND status = 'queued'`);
  return Number(res.rows[0]?.n ?? 0);
}

export async function touchThread(tx: KobeTx, teamId: string, threadId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE threads SET last_activity_at = now() WHERE team_id = ${teamId} AND id = ${threadId}`);
}

export interface NewRun {
  readonly teamId: string;
  readonly threadId: string;
  readonly trigger: RunTrigger;
  readonly approvalMode: ApprovalMode;
  readonly input: string;
  readonly parentEntryId: string | null;
  readonly retryOfRunId: string | null;
  readonly clientKey: string | null;
}

/** Inserts a queued run at the end of the thread's queue (thread lock held). */
export async function insertQueuedRun(tx: KobeTx, run: NewRun): Promise<string> {
  const res = await tx.execute<{ id: string }>(sql`
    INSERT INTO runs (team_id, thread_id, trigger, status, queue_pos, approval_mode, input,
                      parent_entry_id, retry_of_run_id, client_key)
    VALUES (${run.teamId}, ${run.threadId}, ${run.trigger}, 'queued',
            (SELECT coalesce(max(queue_pos), 0) + 1 FROM runs
              WHERE team_id = ${run.teamId} AND thread_id = ${run.threadId} AND status = 'queued'),
            ${run.approvalMode}, ${run.input}, ${run.parentEntryId}, ${run.retryOfRunId},
            ${run.clientKey})
    RETURNING id`);
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error("run insert returned no row");
  return id;
}

// ------------------------------------------------------------------------------ transitions

export interface AppliedTransition {
  readonly runId: string;
  readonly threadId: string;
  readonly from: RunStatus;
  readonly to: RunStatus;
  readonly cause: RunTransitionCause;
}

/**
 * Moves a run along `RUN_TRANSITIONS` (the caller holds the thread lock and passes the locked
 * thread and run): run status (+ started/ended timestamps, queue position cleared), thread status
 * per `nextThreadStatus`, then the event (the append locks the run row and must come last).
 * A run that ends from an active state first expires its pending approvals (KOBE-37:
 * `approval.resolved` before the terminal event; audited). Returns the thread's new status.
 */
export async function applyTransition(
  tx: KobeTx,
  thread: ThreadRow,
  run: RunRow,
  to: RunStatus,
  cause: RunTransitionCause,
  event: NewRunEvent | undefined,
  extra: { readonly parentEntryId?: string | null; readonly approvalMode?: ApprovalMode } = {},
): Promise<{ threadStatus: ThreadStatus; transition: AppliedTransition }> {
  if (!canTransition(run.status, to, cause)) {
    throw new RunError("invalid_transition", `A ${run.status} run can't become ${to}.`);
  }
  const terminal = isTerminalRunStatus(to);
  const active = isActiveRunStatus(to);
  const expired =
    terminal && isActiveRunStatus(run.status)
      ? await expireRunApprovalsInTx(tx, run.teamId, run.id, expiryCauseOf(cause))
      : [];
  await tx.execute(sql`
    UPDATE runs
       SET status = ${to},
           queue_pos = NULL,
           started_at = ${active ? sql`coalesce(started_at, now())` : sql`started_at`},
           ended_at = ${terminal ? sql`now()` : sql`NULL`},
           parent_entry_id = ${extra.parentEntryId === undefined ? sql`parent_entry_id` : extra.parentEntryId},
           approval_mode = ${extra.approvalMode === undefined ? sql`approval_mode` : extra.approvalMode}
     WHERE team_id = ${run.teamId} AND id = ${run.id}`);
  const threadStatus = nextThreadStatus(thread.status, {
    kind: "run_status",
    to,
    was_active: isActiveRunStatus(run.status),
  });
  if (threadStatus !== thread.status || active) {
    await tx.execute(sql`
      UPDATE threads SET status = ${threadStatus}, last_activity_at = now()
       WHERE team_id = ${run.teamId} AND id = ${thread.id}`);
  }
  if (event) await appendRunEventsInTx(tx, run.teamId, run.id, [event]);
  await auditExpiredApprovals(tx, run.teamId, expired);
  return {
    threadStatus,
    transition: { runId: run.id, threadId: thread.id, from: run.status, to, cause },
  };
}

export async function setThreadStatus(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  status: ThreadStatus,
): Promise<void> {
  await tx.execute(sql`
    UPDATE threads SET status = ${status}, last_activity_at = now()
     WHERE team_id = ${teamId} AND id = ${threadId}`);
}

/**
 * Records the Pi entry id of the run's prompt once the wire mirrored it (`runs.user_entry_id`):
 * the first user message entry committed during the run. Best effort; never overwrites.
 */
export async function bindUserEntry(tx: KobeTx, teamId: string, runId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE runs r SET user_entry_id = (
      SELECT e.payload ->> 'entry_id'
        FROM run_events e
        JOIN thread_entries te
          ON te.team_id = e.team_id AND te.thread_id = r.thread_id
         AND te.entry_id = e.payload ->> 'entry_id'
       WHERE e.team_id = ${teamId} AND e.run_id = ${runId} AND e.type = 'entry.committed'
         AND te.type = 'message' AND te.payload -> 'message' ->> 'role' = 'user'
       ORDER BY e.seq LIMIT 1)
     WHERE r.team_id = ${teamId} AND r.id = ${runId} AND r.user_entry_id IS NULL`);
}

/**
 * Where a Retry branches (D14): the original's branch point, so the retry is a sibling of the
 * interrupted prompt. A run that started on an empty thread has none recorded (Pi continued from
 * its leaf), and reusing that would continue after the interrupted partial answer instead; its
 * branch point is the parent of its prompt entry (Pi 1.0 writes a settings entry at the root
 * first). Null when the prompt was never mirrored or sits at the root (`run.start` cannot branch
 * at the root): the retry then continues from the leaf.
 */
export async function retryBranchPoint(
  tx: KobeTx,
  teamId: string,
  run: { readonly id: string; readonly threadId: string; readonly parentEntryId: string | null },
): Promise<string | null> {
  if (run.parentEntryId !== null) return run.parentEntryId;
  await bindUserEntry(tx, teamId, run.id);
  const res = await tx.execute<{ parent_id: string | null }>(sql`
    SELECT te.parent_id
      FROM runs r
      JOIN thread_entries te
        ON te.team_id = ${teamId} AND te.thread_id = ${run.threadId} AND te.entry_id = r.user_entry_id
     WHERE r.team_id = ${teamId} AND r.id = ${run.id} AND r.thread_id = ${run.threadId}`);
  return res.rows[0]?.parent_id ?? null;
}

/** The run a client-supplied idempotency key already created on this thread. */
export async function runByClientKey(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  clientKey: string,
): Promise<{ id: string; status: RunStatus } | undefined> {
  const res = await tx.execute<{ id: string; status: RunStatus }>(sql`
    SELECT id, status FROM runs
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND client_key = ${clientKey}`);
  return res.rows[0];
}

/**
 * A repeated Retry (D14, at most one retry per run): the existing retry run while it is pending or
 * succeeded (idempotent); a clear refusal when it failed, was stopped or was itself interrupted
 * (the one Retry was used; retry the retry, or send the message again).
 */
export async function existingRetry(
  tx: KobeTx,
  teamId: string,
  runId: string,
): Promise<{ runId: string; queued: boolean }> {
  const res = await tx.execute<{ id: string; status: RunStatus }>(sql`
    SELECT id, status FROM runs WHERE team_id = ${teamId} AND retry_of_run_id = ${runId}`);
  const row = res.rows[0];
  if (!row) throw new RunError("run_not_found");
  if (["queued", "running", "waiting_approval", "completed"].includes(row.status)) {
    return { runId: row.id, queued: row.status === "queued" };
  }
  const next =
    row.status === "interrupted"
      ? `Retry the retry run (${row.id}) instead.`
      : "Send the message again.";
  throw new RunError(
    "invalid_transition",
    `This run was already retried once, and the retry ${row.status === "budget_stopped" ? "was budget-stopped" : row.status}. ${next}`,
  );
}

/** The interrupted run an `interrupted` thread is waiting on (Retry or Continue, D14). */
export async function latestInterruptedRow(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<RunRow | undefined> {
  const res = await tx.execute<RawRun>(sql`${RUN_SELECT}
     WHERE r.team_id = ${teamId} AND r.thread_id = ${threadId} AND r.status = 'interrupted'
       AND EXISTS (SELECT 1 FROM threads t
                    WHERE t.team_id = r.team_id AND t.id = r.thread_id AND t.status = 'interrupted')
     ORDER BY r.ended_at DESC, r.created_at DESC LIMIT 1`);
  const row = res.rows[0];
  return row ? fromRaw(row) : undefined;
}

/** Records a stop the sandbox must still receive (cleared by `clearStop` once answered). */
export async function requestStop(
  tx: KobeTx,
  teamId: string,
  runId: string,
  mode: "abort" | "after_step",
): Promise<void> {
  await tx.execute(sql`
    UPDATE runs SET stop_mode = ${mode}, stop_requested_at = now()
     WHERE team_id = ${teamId} AND id = ${runId}`);
}

export async function clearStop(
  tx: KobeTx,
  teamId: string,
  runId: string,
  mode: "abort" | "after_step",
): Promise<void> {
  await tx.execute(sql`
    UPDATE runs SET stop_mode = NULL, stop_requested_at = NULL
     WHERE team_id = ${teamId} AND id = ${runId} AND stop_mode = ${mode}`);
}

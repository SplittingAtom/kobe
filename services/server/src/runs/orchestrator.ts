import {
  checkRetry,
  isActiveRunStatus,
  isTerminalRunStatus,
  nextThreadStatus,
  type ActorContext,
  type ApprovalMode,
  type BudgetStopCommand,
  type RunOrchestrator,
  type RunSnapshot,
  type RunTransition,
  type RunTransitionListener,
  type SteerBody,
  type SubmitMessageCommand,
  type SubmitMessageResult,
  type UpdateQueuedBody,
} from "@kobe/protocol";
import { SYSTEM_ACTOR, sql, withTeam, type AuditActor, type KobeDb, type KobeTx } from "@kobe/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import {
  AppendError,
  appendRunEvents,
  appendRunEventsInTx,
  withAppendTx,
} from "../event-stream/append.js";
import { logger as rootLogger } from "../logger.js";
import { clampApprovalMode, readApprovalModeFloor } from "../sandbox-wire/policy-check.js";
import { endRunInTx } from "../sandbox-wire/run-state.js";
import type { SandboxRouter, SandboxTarget } from "../sandbox-wire/types.js";
import { viewerProjectIds } from "../threads/references.js";
import { findThread, isLockTimeout, type Viewer } from "../threads/repository.js";
import { RunError } from "./errors.js";
import {
  budgetStoppedEvent,
  cancelledEvent,
  failedEvent,
  promoteInTx,
  type Promotion,
  type StartPlan,
} from "./lifecycle.js";
import {
  NO_BUDGETS,
  PASS_THROUGH_AGENTS,
  type IsolationProbe,
  type RunAgentResolver,
  type RunBudgetGate,
} from "./seams.js";
import {
  applyTransition,
  bindUserEntry,
  entryExists,
  getRunRow,
  insertQueuedRun,
  lockRunRow,
  lockThreadRow,
  principalActive,
  queuedCount,
  retryCandidates,
  setThreadLockTimeout,
  setThreadStatus,
  threadRunRows,
  toSnapshot,
  touchThread,
  type AppliedTransition,
  type RunRow,
  type ThreadRow,
} from "./store.js";
import { sweepRuns, type RunSweepResult } from "./sweeper.js";

/** Timings and limits (tests shorten them). */
export interface RunTuning {
  /** Queued messages one thread may hold (D17: "several run in order"). */
  readonly maxQueuedPerThread: number;
  /** After Stop, how long the next queued run waits for Pi's abort before it starts anyway. */
  readonly stopGraceMs: number;
  /**
   * A `running` run with no sandbox lease and no pending `run.start` this long after it started
   * lost its starter (replica crash): the sweep fails it. Above the wire's run.start deadline.
   */
  readonly startDeadlineMs: number;
  /** A thread with queued runs and nothing active for this long is promoted by the sweep. */
  readonly stallMs: number;
  /** Sweep interval (jittered). */
  readonly sweepMs: number;
  /** Promotion retries when the thread row is busy (lock timeout). */
  readonly advanceAttempts: number;
}

export const RUN_DEFAULTS: RunTuning = {
  maxQueuedPerThread: 25,
  stopGraceMs: 10_000,
  startDeadlineMs: 150_000,
  stallMs: 30_000,
  sweepMs: 15_000,
  advanceAttempts: 4,
};

export interface RunOrchestratorOptions {
  readonly db: KobeDb;
  readonly router: SandboxRouter;
  readonly agents?: RunAgentResolver;
  readonly budget?: RunBudgetGate;
  readonly tuning?: Partial<RunTuning>;
  /** Run the sweep on a timer (default true; tests call `sweep()`). */
  readonly sweep?: boolean;
  readonly log?: Logger;
}

/** The orchestrator plus what the server wires around it (wire hooks, sweeps, isolation). */
export interface ServerRunOrchestrator extends RunOrchestrator {
  /** KOBE-24 `RunLifecycleHooks.onRunEnded`: the wire ended a run; advance its thread's queue. */
  onRunEnded(event: { teamId: string; runId: string; threadId: string }): Promise<void>;
  /** Refuse new runs while the isolation runtime is missing (D4); set by index.ts. */
  useIsolation(probe: IsolationProbe): void;
  sweep(): Promise<RunSweepResult>;
  /** Resolves once every background task started so far has finished (tests). */
  idle(): Promise<void>;
  close(): void;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** Steering content shown in `steer.applied` (the event payload cap is 256 KiB). */
const STEER_EVENT_MAX_CHARS = 50_000;

const userActor = (actor: ActorContext): AuditActor => ({ kind: "user", id: actor.user_id });

/**
 * The run orchestrator (KOBE-30; contract `RunOrchestrator`, `@kobe/protocol`). Postgres is the
 * only shared state, so every replica can serve every call: the thread row lock is the per-thread
 * mutex (D17), every status change commits with its `run.*` event, and the sandbox is reached
 * through the KOBE-24 router (which finds the replica holding the sandbox's socket). The wire ends
 * runs it observes (settled, rejected, lost) and calls `onRunEnded`; Stop, queue, retry, budget
 * stops and failed starts are decided here.
 */
export class DbRunOrchestrator implements ServerRunOrchestrator {
  readonly #db: KobeDb;
  readonly #router: SandboxRouter;
  readonly #agents: RunAgentResolver;
  readonly #budget: RunBudgetGate;
  readonly #tuning: RunTuning;
  readonly #log: Logger;
  readonly #tasks = new Set<Promise<unknown>>();
  #listeners: readonly RunTransitionListener[] = [];
  #isolation: IsolationProbe = () => "available";
  #sweepTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: RunOrchestratorOptions) {
    this.#db = options.db;
    this.#router = options.router;
    this.#agents = options.agents ?? PASS_THROUGH_AGENTS;
    this.#budget = options.budget ?? NO_BUDGETS;
    this.#tuning = { ...RUN_DEFAULTS, ...options.tuning };
    this.#log = options.log ?? rootLogger.child({ component: "runs" });
    if (options.sweep !== false) this.#scheduleSweep();
  }

  // ------------------------------------------------------------------------- user operations

  async submitMessage(
    actor: ActorContext,
    command: SubmitMessageCommand,
  ): Promise<SubmitMessageResult> {
    if (this.#isolation() === "missing") throw new RunError("isolation_unavailable");
    if ((command.file_ids?.length ?? 0) > 0) throw new RunError("attachments_unavailable");
    const teamId = actor.team_id;
    const { runId, promotion } = await this.#threadTx(actor, async (tx, viewer) => {
      const thread = await this.#lockOwnedThread(tx, viewer, command.thread_id, "thread_not_found");
      await this.#assertMayRun(tx, actor);
      const parent = command.parent_entry_id ?? null;
      if (parent !== null && !(await entryExists(tx, teamId, thread.id, parent))) {
        throw new RunError("entry_not_found");
      }
      if ((await queuedCount(tx, teamId, thread.id)) >= this.#tuning.maxQueuedPerThread) {
        throw new RunError("queue_full");
      }
      const requested: ApprovalMode =
        command.trigger === "schedule" ? "auto" : (command.approval_mode ?? "ask-on-write");
      const approvalMode = clampApprovalMode(requested, await readApprovalModeFloor(tx, teamId));
      const id = await insertQueuedRun(tx, {
        teamId,
        threadId: thread.id,
        trigger: command.trigger,
        approvalMode,
        input: command.content,
        parentEntryId: parent,
        retryOfRunId: null,
      });
      await touchThread(tx, teamId, thread.id);
      return { runId: id, promotion: await this.#promoteOrQueue(tx, teamId, thread.id, id) };
    });
    this.#afterCommit(teamId, promotion);
    return { run_id: runId, queued: promotion.plan?.runId !== runId };
  }

  async steer(actor: ActorContext, runId: string, body: SteerBody): Promise<RunSnapshot> {
    const run = await this.#threadTx(actor, async (tx, viewer) => {
      const found = await this.#ownedRun(tx, viewer, runId, false);
      await this.#assertMayRun(tx, actor, false);
      return found.run;
    });
    if (!isActiveRunStatus(run.status)) {
      throw new RunError("invalid_transition", `A ${run.status} run can't be steered.`);
    }
    const outcome = await this.#router.steerRun(this.#target(actor.team_id, actor.user_id), {
      runId,
      threadId: run.threadId,
      message: body.content,
    });
    if (!outcome.ok) {
      this.#log.info({ run_id: runId, code: outcome.error.code }, "steer not delivered");
      if (outcome.error.code === "run_not_active") {
        throw new RunError(
          "invalid_transition",
          "The run is not running in your workspace (it is starting or has ended). Try again.",
        );
      }
      throw new RunError("sandbox_unavailable");
    }
    try {
      await appendRunEvents(this.#db, actor.team_id, runId, [
        {
          type: "steer.applied",
          payload: { content: body.content.slice(0, STEER_EVENT_MAX_CHARS) },
        },
      ]);
    } catch (err) {
      // The run ended between Pi accepting the steer and this write: nothing left to show.
      if (!(err instanceof AppendError && err.code === "run_finished")) throw err;
    }
    return this.getRun(actor, runId);
  }

  async cancel(actor: ActorContext, runId: string): Promise<RunSnapshot> {
    const teamId = actor.team_id;
    const result = await this.#threadTx(actor, async (tx, viewer) => {
      const { thread, run } = await this.#ownedRun(tx, viewer, runId, true);
      if (run.status === "cancelled") return { wasActive: false, transition: undefined };
      if (isTerminalRunStatus(run.status)) {
        throw new RunError("invalid_transition", `The run has already ended (${run.status}).`);
      }
      const wasActive = isActiveRunStatus(run.status);
      const applied = await applyTransition(
        tx,
        thread,
        run,
        "cancelled",
        "user_cancelled",
        cancelledEvent(thread),
      );
      await recordAudit(tx, {
        action: "run.cancelled",
        actor: userActor(actor),
        teamId,
        target: { runId, threadId: thread.id, wasActive },
      });
      return { wasActive, transition: applied.transition, threadId: thread.id };
    });
    if (result.transition) this.#emit(teamId, [result.transition]);
    if (result.wasActive && result.threadId !== undefined) {
      const threadId = result.threadId;
      this.#track(this.#stopThenAdvance(actor, runId, threadId));
    }
    return this.getRun(actor, runId);
  }

  async updateQueued(
    actor: ActorContext,
    runId: string,
    body: UpdateQueuedBody,
  ): Promise<RunSnapshot> {
    await this.#threadTx(actor, async (tx, viewer) => {
      const { run } = await this.#ownedRun(tx, viewer, runId, true);
      if (run.status !== "queued") {
        throw new RunError("invalid_transition", "Only queued messages can be edited.");
      }
      await tx.execute(sql`
        UPDATE runs SET input = ${body.content} WHERE team_id = ${actor.team_id} AND id = ${runId}`);
      await touchThread(tx, actor.team_id, run.threadId);
    });
    return this.getRun(actor, runId);
  }

  async retry(actor: ActorContext, runId: string): Promise<SubmitMessageResult> {
    if (this.#isolation() === "missing") throw new RunError("isolation_unavailable");
    const teamId = actor.team_id;
    const out = await this.#threadTx(actor, async (tx, viewer) => {
      const { thread, run } = await this.#ownedRun(tx, viewer, runId, true);
      if (thread.deletedAt !== null) throw new RunError("thread_in_trash");
      await this.#assertMayRun(tx, actor);
      const check = checkRetry(await retryCandidates(tx, teamId, thread.id), runId);
      if (check === "already_retried") {
        const existing = await tx.execute<{ id: string; status: string }>(sql`
          SELECT id, status FROM runs WHERE team_id = ${teamId} AND retry_of_run_id = ${runId}`);
        const row = existing.rows[0];
        if (!row) throw new RunError("run_not_found");
        return { runId: row.id, queued: row.status === "queued", promotion: undefined };
      }
      if (check === "not_interrupted") {
        throw new RunError("invalid_transition", "Only interrupted runs can be retried.");
      }
      if (check === "not_latest") {
        throw new RunError("invalid_transition", "Only the thread's latest run can be retried.");
      }
      const id = await insertQueuedRun(tx, {
        teamId,
        threadId: thread.id,
        trigger: run.trigger,
        approvalMode: run.approvalMode,
        input: run.input,
        // Same branch point as the original: the retry is a sibling branch; history stays intact.
        parentEntryId: run.parentEntryId,
        retryOfRunId: runId,
      });
      await touchThread(tx, teamId, thread.id);
      const promotion = await this.#promoteOrQueue(tx, teamId, thread.id, id);
      await recordAudit(tx, {
        action: "run.retried",
        actor: userActor(actor),
        teamId,
        target: { runId: id, threadId: thread.id, retryOfRunId: runId },
      });
      return { runId: id, queued: promotion.plan?.runId !== id, promotion };
    });
    if (out.promotion) this.#afterCommit(teamId, out.promotion);
    return { run_id: out.runId, queued: out.queued };
  }

  async resumeQueue(actor: ActorContext, threadId: string): Promise<void> {
    const promotion = await this.#threadTx(actor, async (tx, viewer) => {
      const thread = await this.#lockOwnedThread(tx, viewer, threadId, "thread_not_found");
      if (thread.status !== "interrupted") return undefined;
      await setThreadStatus(
        tx,
        actor.team_id,
        thread.id,
        nextThreadStatus(thread.status, { kind: "queue_resumed" }),
      );
      return promoteInTx(tx, this.#agents, actor.team_id, thread.id);
    });
    if (promotion) this.#afterCommit(actor.team_id, promotion);
  }

  async getRun(actor: ActorContext, runId: string): Promise<RunSnapshot> {
    const run = await this.#readTx(actor, async (tx, viewer) => {
      const row = await getRunRow(tx, actor.team_id, runId);
      if (!row || !(await findThread(tx, viewer, row.threadId))) return undefined;
      return row;
    });
    if (!run) throw new RunError("run_not_found");
    return toSnapshot(run);
  }

  async listThreadRuns(actor: ActorContext, threadId: string): Promise<readonly RunSnapshot[]> {
    const rows = await this.#readTx(actor, async (tx, viewer) => {
      if (!(await findThread(tx, viewer, threadId))) return undefined;
      return threadRunRows(tx, actor.team_id, threadId);
    });
    if (!rows) throw new RunError("thread_not_found");
    return rows.map(toSnapshot);
  }

  // ------------------------------------------------------------------------- internal entry points

  async stopForBudget(command: BudgetStopCommand): Promise<readonly string[]> {
    const teamId = command.team_id;
    const candidates = await withTeam(this.#db, teamId, async (tx) => {
      const res = await tx.execute<{ id: string; thread_id: string; owner_user_id: string }>(sql`
        SELECT r.id, r.thread_id, t.owner_user_id
          FROM runs r JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
         WHERE r.team_id = ${teamId}
           AND r.status IN ('queued', 'running', 'waiting_approval')
           ${command.user_id === undefined ? sql`` : sql`AND t.owner_user_id = ${command.user_id}`}
         ORDER BY r.status <> 'queued'`);
      return res.rows;
    });
    const affected: string[] = [];
    // Queued runs first, so stopping an active run never promotes one about to be stopped.
    let failures = 0;
    for (const c of candidates) {
      const outcome = await this.#withRetry(() =>
        withAppendTx(this.#db, teamId, async (tx) => {
          const thread = await lockThreadRow(tx, teamId, c.thread_id);
          const run = await lockRunRow(tx, teamId, c.id);
          if (!thread || !run || isTerminalRunStatus(run.status)) return undefined;
          if (run.status === "queued") {
            const applied = await applyTransition(
              tx,
              thread,
              run,
              "budget_stopped",
              "budget_exhausted",
              budgetStoppedEvent(command.scope),
            );
            return { transition: applied.transition, active: false };
          }
          // Active: finish the current step (D30). The wire converts the settle into budget_stopped.
          await tx.execute(sql`
          UPDATE runs SET budget_stop_scope = ${command.scope}
           WHERE team_id = ${teamId} AND id = ${run.id}`);
          return { transition: undefined, active: true };
        }),
      ).catch((err: unknown) => {
        // Keep stopping the others; the caller learns that some could not be stopped.
        failures += 1;
        this.#log.error({ err, run_id: c.id }, "budget stop failed for a run");
        return undefined;
      });
      if (!outcome) continue;
      affected.push(c.id);
      if (outcome.transition) this.#emit(teamId, [outcome.transition]);
      if (outcome.active) {
        this.#track(this.#budgetStopActive(teamId, c.id, c.thread_id, c.owner_user_id, command));
      }
    }
    if (failures > 0) {
      throw new Error(`budget stop: ${failures} run(s) could not be stopped; call again`);
    }
    return affected;
  }

  async markSandboxLost(teamId: string, sandboxId: string): Promise<readonly string[]> {
    const runs = await withTeam(this.#db, teamId, async (tx) => {
      const res = await tx.execute<{ run_id: string; thread_id: string }>(sql`
        SELECT l.run_id, l.thread_id FROM sandbox_run_leases l
          JOIN runs r ON r.team_id = l.team_id AND r.id = l.run_id
         WHERE l.team_id = ${teamId} AND l.sandbox_id = ${sandboxId}
           AND r.status IN ('running', 'waiting_approval')`);
      return res.rows;
    });
    const ended: string[] = [];
    for (const run of runs) {
      const result = await withAppendTx(this.#db, teamId, (tx) =>
        endRunInTx(tx, teamId, run.run_id, { status: "interrupted" }, "sandbox_gone"),
      );
      if (!result.ended) continue;
      ended.push(run.run_id);
      await this.onRunEnded({ teamId, runId: run.run_id, threadId: run.thread_id });
    }
    return ended;
  }

  onTransition(listener: RunTransitionListener): () => void {
    this.#listeners = [...this.#listeners, listener];
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  }

  async onRunEnded(event: { teamId: string; runId: string; threadId: string }): Promise<void> {
    if (this.#closed) return;
    try {
      await withTeam(this.#db, event.teamId, (tx) => bindUserEntry(tx, event.teamId, event.runId));
    } catch (err) {
      this.#log.warn({ err, run_id: event.runId }, "could not bind the run's prompt entry");
    }
    try {
      await this.#notifyWireEnd(event);
    } catch (err) {
      this.#log.warn({ err, run_id: event.runId }, "could not report a run transition");
    }
    await this.#advance(event.teamId, event.threadId);
  }

  async #notifyWireEnd(event: { teamId: string; runId: string }): Promise<void> {
    if (this.#listeners.length === 0) return;
    const row = await withTeam(this.#db, event.teamId, (tx) =>
      getRunRow(tx, event.teamId, event.runId),
    );
    if (!row || !isTerminalRunStatus(row.status)) return;
    // The wire ended an active run; it reports neither the prior state nor the cause.
    const causes = {
      completed: "settled",
      interrupted: "sandbox_lost",
      budget_stopped: "budget_exhausted",
    } as const;
    this.#notify(row, {
      runId: row.id,
      threadId: row.threadId,
      from: "running",
      to: row.status,
      cause: row.status in causes ? causes[row.status as keyof typeof causes] : "error",
    });
  }

  async #safeAdvance(teamId: string, threadId: string): Promise<void> {
    try {
      await this.#advance(teamId, threadId);
    } catch (err) {
      this.#log.error({ err, thread_id: threadId }, "queue promotion failed");
    }
  }

  useIsolation(probe: IsolationProbe): void {
    this.#isolation = probe;
  }

  async sweep(): Promise<RunSweepResult> {
    const result = await sweepRuns(this.#db, this.#tuning, this.#log);
    for (const stuck of result.failedStarts) this.#emit(stuck.teamId, [stuck.transition]);
    const threads = [
      ...result.failedStarts.map((s) => ({ teamId: s.teamId, threadId: s.transition.threadId })),
      ...result.stalledThreads,
    ];
    // One failing thread never blocks the others.
    for (const t of threads) await this.#safeAdvance(t.teamId, t.threadId);
    return result;
  }

  async idle(): Promise<void> {
    while (this.#tasks.size > 0) await Promise.allSettled([...this.#tasks]);
  }

  close(): void {
    this.#closed = true;
    if (this.#sweepTimer) clearTimeout(this.#sweepTimer);
  }

  // ------------------------------------------------------------------------- helpers

  #target(teamId: string, userId: string): SandboxTarget {
    return { teamId, userId };
  }

  #track(task: Promise<unknown>): void {
    const tracked = task
      .catch((err: unknown) => this.#log.error({ err }, "run orchestrator task failed"))
      .finally(() => this.#tasks.delete(tracked));
    this.#tasks.add(tracked);
  }

  /** A team transaction as `actor` (thread lock timeout set); a busy thread is 409 thread_busy. */
  async #threadTx<T>(actor: ActorContext, fn: (tx: KobeTx, viewer: Viewer) => Promise<T>) {
    try {
      return await withTeam(this.#db, actor.team_id, async (tx) => {
        await setThreadLockTimeout(tx);
        return fn(tx, await this.#viewer(tx, actor));
      });
    } catch (err) {
      if (isLockTimeout(err)) throw new RunError("thread_busy");
      throw err;
    }
  }

  #readTx<T>(actor: ActorContext, fn: (tx: KobeTx, viewer: Viewer) => Promise<T>): Promise<T> {
    return withTeam(this.#db, actor.team_id, async (tx) => fn(tx, await this.#viewer(tx, actor)));
  }

  async #viewer(tx: KobeTx, actor: ActorContext): Promise<Viewer> {
    return {
      teamId: actor.team_id,
      userId: actor.user_id,
      projectIds: await viewerProjectIds(tx, actor.user_id),
    };
  }

  /**
   * Locks a thread the actor owns (KOBE-34 visibility: readers of a shared thread get `read_only`,
   * everyone else the same 404) and refuses Trash. The thread row is the first lock taken.
   */
  async #lockOwnedThread(
    tx: KobeTx,
    viewer: Viewer,
    threadId: string,
    notFound: "thread_not_found" | "run_not_found",
  ): Promise<ThreadRow> {
    const found = await findThread(tx, viewer, threadId, { lock: true });
    if (!found) throw new RunError(notFound);
    if (found.access !== "owner") throw new RunError("read_only");
    const thread = await lockThreadRow(tx, viewer.teamId, threadId);
    if (!thread) throw new RunError(notFound);
    if (thread.deletedAt !== null) throw new RunError("thread_in_trash");
    return thread;
  }

  /** The run and its thread for a change by the thread's owner (thread locked, then the run). */
  async #ownedRun(
    tx: KobeTx,
    viewer: Viewer,
    runId: string,
    lock: boolean,
  ): Promise<{ thread: ThreadRow; run: RunRow }> {
    const head = await getRunRow(tx, viewer.teamId, runId);
    if (!head) throw new RunError("run_not_found");
    if (!lock) {
      const found = await findThread(tx, viewer, head.threadId);
      if (!found) throw new RunError("run_not_found");
      if (found.access !== "owner") throw new RunError("read_only");
      return { thread: found.thread, run: head };
    }
    const thread = await this.#lockOwnedThread(tx, viewer, head.threadId, "run_not_found");
    const run = await lockRunRow(tx, viewer.teamId, runId);
    if (!run) throw new RunError("run_not_found");
    return { thread, run };
  }

  /** KOBE-13: deactivated or removed users can't start or steer runs (budget gate: KOBE-42). */
  async #assertMayRun(tx: KobeTx, actor: ActorContext, checkBudget = true): Promise<void> {
    if (!(await principalActive(tx, actor.team_id, actor.user_id))) {
      throw new RunError("forbidden", "Your account can't run agents in this team.");
    }
    if (
      checkBudget &&
      !(await this.#budget.allowsNewRun(tx, { teamId: actor.team_id, userId: actor.user_id }))
    ) {
      throw new RunError("budget_exhausted");
    }
  }

  /** Promotes the thread; if `runId` did not start, records `run.queued` with its position. */
  async #promoteOrQueue(
    tx: KobeTx,
    teamId: string,
    threadId: string,
    runId: string,
  ): Promise<Promotion> {
    const promotion = await promoteInTx(tx, this.#agents, teamId, threadId);
    if (promotion.plan?.runId !== runId) {
      const row = await getRunRow(tx, teamId, runId);
      if (row?.status === "queued" && row.queueRank !== null) {
        await appendRunEventsInTx(tx, teamId, runId, [
          {
            type: "run.queued",
            payload: { thread_id: threadId, trigger: row.trigger, queue_pos: row.queueRank },
          },
        ]);
      }
    }
    return promotion;
  }

  #afterCommit(teamId: string, promotion: Promotion): void {
    this.#emit(teamId, promotion.transitions);
    if (promotion.plan) this.#track(this.#start(promotion.plan));
  }

  #emit(teamId: string, transitions: readonly AppliedTransition[]): void {
    if (this.#listeners.length === 0 || transitions.length === 0) return;
    this.#track(
      withTeam(this.#db, teamId, async (tx) => {
        for (const t of transitions) {
          const row = await getRunRow(tx, teamId, t.runId);
          if (row) this.#notify(row, t);
        }
      }),
    );
  }

  #notify(row: RunRow, t: AppliedTransition): void {
    const transition: RunTransition = {
      run: toSnapshot(row),
      from: t.from,
      to: t.to,
      cause: t.cause,
      at: new Date().toISOString(),
    };
    for (const listener of this.#listeners) {
      try {
        listener(transition);
      } catch (err) {
        this.#log.warn({ err }, "run transition listener failed");
      }
    }
  }

  /** Sends `run.start`; a start that no sandbox took fails the run here (KOBE-24 contract). */
  async #start(plan: StartPlan): Promise<void> {
    const outcome = await this.#router.startRun(this.#target(plan.teamId, plan.ownerUserId), {
      runId: plan.runId,
      threadId: plan.threadId,
      message: plan.input,
      ...(plan.parentEntryId !== null ? { parentEntryId: plan.parentEntryId } : {}),
      config: {
        ...plan.config,
        agent:
          plan.agent === null
            ? null
            : { agent_id: plan.agent.agentId, version: plan.agent.version },
        approval_mode: plan.approvalMode,
      },
    });
    if (outcome.ok || this.#closed) return;
    this.#log.warn({ run_id: plan.runId, code: outcome.error.code }, "run.start failed");
    await this.#startFailed(plan, outcome.error.code);
  }

  /**
   * The wire already ended runs whose `run.start` the sandbox rejected. Without a lease nobody else
   * will end the run (the sweep only watches leased runs), so it fails here; with a lease the wire
   * owns it (a reconnect resumes it, the sweep interrupts it) — except after a timeout, when the
   * sandbox holds the run but does not answer: fail it and ask the sandbox to abort.
   */
  async #startFailed(plan: StartPlan, code: string): Promise<void> {
    const ended = await withAppendTx(this.#db, plan.teamId, async (tx) => {
      const thread = await lockThreadRow(tx, plan.teamId, plan.threadId);
      const run = await lockRunRow(tx, plan.teamId, plan.runId);
      if (!thread || !run || !isActiveRunStatus(run.status)) return undefined;
      const lease = await tx.execute(sql`
        SELECT 1 FROM sandbox_run_leases WHERE team_id = ${plan.teamId} AND run_id = ${plan.runId}`);
      const leased = lease.rows.length > 0;
      if (leased && code !== "timeout") return undefined;
      const applied = await applyTransition(tx, thread, run, "failed", "error", failedEvent(code));
      return { transition: applied.transition, leased };
    });
    if (!ended) return;
    this.#emit(plan.teamId, [ended.transition]);
    if (ended.leased) {
      this.#track(
        this.#router.stopRun(this.#target(plan.teamId, plan.ownerUserId), {
          runId: plan.runId,
          threadId: plan.threadId,
          mode: "abort",
          reason: "user_cancelled",
        }),
      );
    }
    await this.#advance(plan.teamId, plan.threadId);
  }

  /** Stop (D17): abort in the sandbox, then start the next queued run (after Pi's abort or a grace). */
  async #stopThenAdvance(actor: ActorContext, runId: string, threadId: string): Promise<void> {
    // Only the owner can Stop, and the sandbox is the owner's (D11).
    const stop = this.#router.stopRun(this.#target(actor.team_id, actor.user_id), {
      runId,
      threadId,
      mode: "abort",
      reason: "user_cancelled",
    });
    this.#track(stop);
    await Promise.race([stop, delay(this.#tuning.stopGraceMs)]);
    await this.#advance(actor.team_id, threadId);
  }

  /** D30: let the current step finish, then end the run `budget_stopped` if Pi didn't settle it. */
  async #budgetStopActive(
    teamId: string,
    runId: string,
    threadId: string,
    ownerUserId: string,
    command: BudgetStopCommand,
  ): Promise<void> {
    await this.#router.stopRun(this.#target(teamId, ownerUserId), {
      runId,
      threadId,
      mode: "after_step",
      reason: "budget_exhausted",
    });
    if (this.#closed) return;
    const ended = await withAppendTx(this.#db, teamId, async (tx) => {
      const thread = await lockThreadRow(tx, teamId, threadId);
      const run = await lockRunRow(tx, teamId, runId);
      if (!thread || !run || !isActiveRunStatus(run.status)) return undefined;
      const applied = await applyTransition(
        tx,
        thread,
        run,
        "budget_stopped",
        "budget_exhausted",
        budgetStoppedEvent(command.scope),
      );
      await recordAudit(tx, {
        action: "run.budget_stopped",
        actor: SYSTEM_ACTOR,
        teamId,
        target: { runId, threadId, scope: command.scope },
      });
      return applied.transition;
    });
    if (!ended) return;
    this.#emit(teamId, [ended]);
    await this.#advance(teamId, threadId);
  }

  /** Starts the thread's next run if it may start; retried while the thread row is busy. */
  async #advance(teamId: string, threadId: string): Promise<void> {
    for (let attempt = 0; attempt < this.#tuning.advanceAttempts; attempt += 1) {
      if (this.#closed) return;
      try {
        const promotion = await withTeam(this.#db, teamId, async (tx) => {
          await setThreadLockTimeout(tx);
          return promoteInTx(tx, this.#agents, teamId, threadId);
        });
        this.#afterCommit(teamId, promotion);
        return;
      } catch (err) {
        if (!isLockTimeout(err)) throw err;
        await delay(200 * 2 ** attempt);
      }
    }
    // The sweep promotes stalled queues later.
    this.#log.warn({ thread_id: threadId }, "thread busy; queue promotion left to the sweep");
  }

  /** Retries `fn` while it fails on a busy row (lock timeout), like promotion does. */
  async #withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        if (!isLockTimeout(err) || attempt + 1 >= this.#tuning.advanceAttempts) throw err;
        await delay(200 * 2 ** attempt);
      }
    }
  }

  #scheduleSweep(): void {
    this.#sweepTimer = setTimeout(
      () => {
        this.sweep()
          .catch((err: unknown) => this.#log.error({ err }, "run sweep failed"))
          .finally(() => {
            if (!this.#closed) this.#scheduleSweep();
          });
      },
      this.#tuning.sweepMs * (0.5 + Math.random()),
    );
    this.#sweepTimer.unref();
  }
}

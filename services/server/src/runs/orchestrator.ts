import {
  imitatesAppContext,
  imitatesSkillRequest,
  splitAppContext,
  splitSkillRequest,
  withSkillRequest,
  type RunViewingContext,
} from "@kobe/protocol";
import { effectiveSkillNames } from "./effective-skills.js";
import { connectorsOffIn } from "../connectors/thread-connectors.js";
import { RUN_INPUT_MAX_CHARS } from "@kobe/db";
import {
  resolveAppContexts,
  withAppContext,
  type ResolvedAppContext,
} from "../apps/context-block.js";
import {
  checkRetry,
  isActiveRunStatus,
  isTerminalRunStatus,
  nextThreadStatus,
  type ActorContext,
  type ApprovalMode,
  type BudgetStopCommand,
  type CompactThreadResponse,
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
import { auditExpiredApprovals, expireRunApprovalsInTx } from "../approvals/run-end.js";
import { recordAudit } from "../audit/record.js";
import {
  AppendError,
  appendRunEvents,
  appendRunEventsInTx,
  withAppendTx,
} from "../event-stream/append.js";
import { logger as rootLogger } from "../logger.js";
import { readApprovalFloor } from "../policy/approval-floor.js";
import { isSkippedSummaryEntry } from "../policy/skipped-summary.js";
import { clampApprovalMode } from "../sandbox-wire/policy-check.js";
import { endRunInTx } from "../sandbox-wire/run-state.js";
import type { SandboxRouter, SandboxTarget } from "../sandbox-wire/types.js";
import { viewerProjectIds } from "../threads/references.js";
import { findThread, isLockTimeout, type Viewer } from "../threads/repository.js";
import type { AttachmentStager, StagedFile } from "../uploads/attach.js";
import type { ViewingReader } from "../workspace-files/viewing.js";
import { cancelScheduledRuns, type ScheduledCancelReason } from "./cancel-scheduled.js";
import { RunError } from "./errors.js";
import { checkMentionPaths, rewriteMentions } from "./mentions.js";
import { compactThread } from "./compaction.js";
import {
  budgetStoppedEvent,
  cancelledEvent,
  failedEvent,
  promoteInTx,
  type Promotion,
} from "./lifecycle.js";
import type { ScheduledSubmit } from "./scheduled-submit.js";
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
  existingRetry,
  latestInterruptedRow,
  requestStop,
  setQueuePaused,
  isQueuePaused,
  retryBranchPoint,
  runByClientKey,
  getRunRow,
  insertQueuedRun,
  isMessageRun,
  lockRunRow,
  lockThreadRow,
  principalActive,
  queuedCount,
  retryCandidates,
  runViewing,
  setThreadLockTimeout,
  setThreadStatus,
  threadRunRows,
  toSnapshot,
  touchThread,
  type AppliedTransition,
  type RunRow,
} from "./store.js";
import { lockOwnedThread, ownedRun } from "./access.js";
import { queuedMessageCount, reorderQueuedRuns } from "./queue-order.js";
import { RunDispatcher, type StopTarget } from "./dispatch.js";
import { sweepRuns, type RunSweepResult } from "./sweeper.js";
import { MODEL_TOKEN_DEFAULTS, type ModelTokenDefaults } from "../models/token-limits.js";

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
  /**
   * A compaction run still active this long after it started has lost its requester (KOBE-213):
   * the sweep fails it and aborts it. Above the `thread.compact` command deadline.
   */
  readonly compactionDeadlineMs: number;
  /** A thread with queued runs and nothing active for this long is promoted by the sweep. */
  readonly stallMs: number;
  /** Sweep interval (jittered). */
  readonly sweepMs: number;
  /** Promotion retries when the thread row is busy (lock timeout). */
  readonly advanceAttempts: number;
  /** A lost start younger than this is re-sent; older ones fail `start_lost`. */
  readonly restartWindowMs: number;
  /** A pending stop with no `run.stop` in flight this long is sent again. */
  readonly stopResendMs: number;
  /** A stop still unanswered after this long is given up. */
  readonly stopGiveUpMs: number;
}

export const RUN_DEFAULTS: RunTuning = {
  maxQueuedPerThread: 25,
  stopGraceMs: 10_000,
  startDeadlineMs: 150_000,
  compactionDeadlineMs: 15 * 60_000,
  stallMs: 30_000,
  sweepMs: 15_000,
  advanceAttempts: 4,
  restartWindowMs: 15 * 60_000,
  stopResendMs: 60_000,
  stopGiveUpMs: 60 * 60_000,
};

export interface RunOrchestratorOptions {
  readonly db: KobeDb;
  readonly router: SandboxRouter;
  readonly agents?: RunAgentResolver;
  readonly budget?: RunBudgetGate;
  readonly tuning?: Partial<RunTuning>;
  /** Limits of models without their own in the catalog (KOBE-259); default `MODEL_TOKEN_DEFAULTS`. */
  readonly modelTokenDefaults?: ModelTokenDefaults;
  /** Run the sweep on a timer (default true; tests call `sweep()`). */
  readonly sweep?: boolean;
  readonly log?: Logger;
}

/** Uploads staged for a message, between validation and the submit transaction (KOBE-144). */
interface StagedAttachments {
  readonly owner: { readonly teamId: string; readonly userId: string };
  readonly caller: { readonly teamId: string; readonly userId: string };
  readonly staged: readonly StagedFile[];
}

/** The orchestrator plus what the server wires around it (wire hooks, sweeps, isolation). */
export interface ServerRunOrchestrator extends RunOrchestrator {
  /** The Stop grace a promotion waits for Pi's abort (KOBE-26); app-card launches wait it too. */
  readonly abortHoldMs?: number;
  /** `submitMessage` with a client idempotency key (unique per thread). */
  submitMessage(
    actor: ActorContext,
    command: SubmitMessageCommand,
    options?: { readonly clientKey?: string; readonly scheduled?: ScheduledSubmit },
  ): Promise<SubmitMessageResult>;
  /** The run an `interrupted` thread waits on (Retry), or null. */
  latestInterruptedRun(actor: ActorContext, threadId: string): Promise<RunSnapshot | null>;
  /** Messages wait behind a Stop until the user resumes the queue or sends one (KOBE-26). */
  queuePaused(actor: ActorContext, threadId: string): Promise<boolean>;
  /** The owner reorders the queued messages (CE10): `runIds` is the whole queue, in order. */
  reorderQueue(actor: ActorContext, threadId: string, runIds: readonly string[]): Promise<void>;
  /** The owner holds the queue until resumed or a new message (CE10); no-op with nothing queued. */
  pauseQueue(actor: ActorContext, threadId: string): Promise<void>;
  /**
   * Compact now (KOBE-213): a compaction run on the owner's idle thread, answered once Pi did it.
   * Throws `CompactionError` (a code of the compact contract) or `RunError` (404/403/trash).
   */
  compact(actor: ActorContext, threadId: string, focus?: string): Promise<CompactThreadResponse>;
  /** KOBE-24 `RunLifecycleHooks.onRunEnded`: the wire ended a run; advance its thread's queue. */
  onRunEnded(event: { teamId: string; runId: string; threadId: string }): Promise<void>;
  /** KOBE-180: the system cancels a deactivated or removed owner's in-flight scheduled runs. */
  cancelScheduledRuns(
    teamId: string,
    userId: string,
    reason: ScheduledCancelReason,
  ): Promise<readonly string[]>;
  /** Refuse new runs while the isolation runtime is missing (D4); set by index.ts. */
  useIsolation(probe: IsolationProbe): void;
  /** Wire message attachments (KOBE-144); without it `file_ids` are refused `attachments_unavailable`. */
  useAttachments(stager: AttachmentStager): void;
  /** Reads a message's viewed file (KOBE-462); without it `viewing` adds nothing to the run. */
  useViewing(reader: ViewingReader): void;
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

const WIRE_END_CAUSES = {
  completed: "settled",
  interrupted: "sandbox_lost",
  budget_stopped: "budget_exhausted",
} as const;

const userActor = (actor: ActorContext): AuditActor => ({ kind: "user", id: actor.user_id });

/** The workspace a thread's runs use: its owner's, in its team (D11). */
const ownerOf = (teamId: string, thread: { readonly ownerUserId: string }) => ({
  teamId,
  userId: thread.ownerUserId,
});

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
  readonly #modelTokenDefaults: ModelTokenDefaults;
  readonly #log: Logger;
  readonly #tasks = new Set<Promise<unknown>>();
  #listeners: readonly RunTransitionListener[] = [];
  #isolation: IsolationProbe = () => "available";
  #attachments: AttachmentStager | undefined;
  #viewing: ViewingReader | undefined;
  #sweepTimer: NodeJS.Timeout | undefined;
  #closed = false;
  readonly #dispatch: RunDispatcher;

  constructor(options: RunOrchestratorOptions) {
    this.#db = options.db;
    this.#router = options.router;
    this.#agents = options.agents ?? PASS_THROUGH_AGENTS;
    this.#budget = options.budget ?? NO_BUDGETS;
    this.#tuning = { ...RUN_DEFAULTS, ...options.tuning };
    this.#modelTokenDefaults = options.modelTokenDefaults ?? MODEL_TOKEN_DEFAULTS;
    this.#log = options.log ?? rootLogger.child({ component: "runs" });
    this.#dispatch = new RunDispatcher({
      db: this.#db,
      router: this.#router,
      agents: this.#agents,
      tuning: this.#tuning,
      modelTokenDefaults: this.#modelTokenDefaults,
      log: this.#log,
      closed: () => this.#closed,
      emit: (teamId, transitions) => this.#emit(teamId, transitions),
      advance: (teamId, threadId) => this.#advance(teamId, threadId),
      track: (task) => this.#track(task),
    });
    if (options.sweep !== false) this.#scheduleSweep();
  }

  get abortHoldMs(): number {
    return this.#tuning.stopGraceMs;
  }

  /** Promotion waits for Pi's abort of a stopped run, at most the Stop grace (KOBE-26). */
  get #hold(): { readonly abortHoldMs: number } {
    return { abortHoldMs: this.#tuning.stopGraceMs };
  }

  // ------------------------------------------------------------------------- user operations

  async submitMessage(
    actor: ActorContext,
    command: SubmitMessageCommand,
    options: { readonly clientKey?: string; readonly scheduled?: ScheduledSubmit } = {},
  ): Promise<SubmitMessageResult> {
    if (this.#isolation() === "missing") throw new RunError("isolation_unavailable");
    // A member's mentions are checked before any upload is staged (KOBE-223 N1).
    if (command.trigger === "user") checkMentionPaths(command.mentions ?? []);
    // Only the server writes app context (KOBE-439 review LOW-E): a member's text that imitates
    // it would show as a chip in history and could be mistaken for an app's data.
    if (
      command.trigger === "user" &&
      (imitatesAppContext(command.content) || imitatesSkillRequest(command.content))
    ) {
      throw new RunError("invalid_content");
    }
    // MCP Apps context chips (KOBE-439): only apps the member can open now, same template.
    const appContext = await resolveAppContexts(
      this.#db,
      actor.team_id,
      actor.user_id,
      command.trigger === "user" ? (command.app_context ?? []) : [],
    );
    if (appContext === undefined) throw new RunError("app_context_invalid");
    const viewing = await this.#readViewing(actor, command);
    const withViewing = viewing === undefined ? command : { ...command, resolvedViewing: viewing };
    const fileIds = command.file_ids ?? [];
    if (fileIds.length > 0 && this.#attachments === undefined) {
      throw new RunError("attachments_unavailable");
    }
    const clientKey = options.clientKey ?? null;
    const attach =
      fileIds.length > 0 ? await this.#stageAttachments(actor, command, clientKey) : undefined;
    if (attach === undefined) {
      return this.#submitInTx(
        actor,
        withViewing,
        clientKey,
        undefined,
        () => {},
        options.scheduled,
        appContext,
      );
    }
    // The copies stay only when the run row (and the files' claim) committed with them.
    let claimed = false;
    let committed = false;
    try {
      const result = await this.#submitInTx(
        actor,
        withViewing,
        clientKey,
        attach,
        () => {
          claimed = true;
        },
        undefined,
        appContext,
      );
      committed = claimed;
      return result;
    } finally {
      if (committed) await this.#attachments?.finalize(attach.staged);
      else await this.#attachments?.discard(attach.staged);
    }
  }

  /** Validates the files and copies them (object store, no transaction held); see uploads/attach.ts. */
  async #stageAttachments(
    actor: ActorContext,
    command: SubmitMessageCommand,
    clientKey: string | null,
  ): Promise<StagedAttachments | undefined> {
    const stager = this.#attachments;
    if (stager === undefined) throw new RunError("attachments_unavailable");
    const caller = { teamId: actor.team_id, userId: actor.user_id };
    const found = await this.#threadTx(actor, async (tx, viewer) => {
      const thread = await lockOwnedThread(tx, viewer, command.thread_id, "thread_not_found");
      // A repeated submission is answered with its run; nothing to attach again.
      if (clientKey !== null && (await runByClientKey(tx, caller.teamId, thread.id, clientKey))) {
        return undefined;
      }
      const files = await stager.inspect(tx, caller, thread.id, command.file_ids ?? []);
      return {
        threadId: thread.id,
        owner: { teamId: caller.teamId, userId: thread.ownerUserId },
        files,
      };
    });
    if (found === undefined) return undefined;
    const staged = await stager.stage(found.owner, caller, found.threadId, found.files);
    return { owner: found.owner, caller, staged };
  }

  /**
   * The member's viewed file (KOBE-462, spec FE6), read from their own synced workspace before the
   * transaction (object storage); only for their own messages. Missing or unreadable: none.
   */
  async #readViewing(
    actor: ActorContext,
    command: SubmitMessageCommand,
  ): Promise<RunViewingContext | undefined> {
    if (command.trigger !== "user" || command.viewing === undefined) return undefined;
    return this.#viewing?.({ teamId: actor.team_id, userId: actor.user_id }, command.viewing.path);
  }

  async #submitInTx(
    actor: ActorContext,
    command: SubmitMessageCommand & { readonly resolvedViewing?: RunViewingContext },
    clientKey: string | null,
    attach: StagedAttachments | undefined,
    onAttached: () => void,
    scheduled?: ScheduledSubmit,
    appContext: readonly ResolvedAppContext[] = [],
  ): Promise<SubmitMessageResult> {
    const teamId = actor.team_id;
    const out = await this.#threadTx(actor, async (tx, viewer) => {
      await scheduled?.before(tx);
      const thread = await lockOwnedThread(tx, viewer, command.thread_id, "thread_not_found");
      if (clientKey !== null) {
        // A repeated submission (same key, same thread) answers with the run it created.
        const seen = await runByClientKey(tx, teamId, thread.id, clientKey);
        if (seen) return { result: { run_id: seen.id, queued: seen.status === "queued" } };
      }
      // App context from a connector turned off in this thread is refused (review LOW-5).
      if (appContext.length > 0) {
        const off = await connectorsOffIn(tx, teamId, thread.id);
        if (appContext.some((a) => a.connectorId !== undefined && off.has(a.connectorId))) {
          throw new RunError("app_context_invalid");
        }
      }
      // @file mentions (KOBE-223) resolve against the owner's own workspace, never the client's
      // word. A member's bad mention refuses the message; a schedule's file that is gone by now
      // stays literal text and the run goes ahead.
      const mentioned = await rewriteMentions(
        tx,
        ownerOf(teamId, thread),
        command.content,
        command.mentions ?? [],
        command.trigger === "user" ? "refuse" : "keep",
      );
      if (mentioned.skipped > 0) {
        this.#log.warn(
          { team_id: teamId, thread_id: thread.id, skipped: mentioned.skipped },
          "mentioned files not found; left as text",
        );
      }
      // A skill picked in the composer (KOBE-451) must be one a run here loads; the server's
      // line asks the agent to use it. The run start checks it once more.
      const skill = command.trigger === "user" ? command.skill : undefined;
      if (skill !== undefined) {
        const names = await effectiveSkillNames(tx, this.#agents, {
          teamId,
          ...thread,
          threadId: thread.id,
        });
        if (!names.includes(skill)) throw new RunError("skill_not_available");
      }
      const text = skill === undefined ? mentioned.text : withSkillRequest(skill, mentioned.text);
      // The member's chips go first, fenced as untrusted data (KOBE-439, spec §8).
      const input = withAppContext(appContext, text);
      // The rendered blocks count toward the input's limit (review LOW-F): a clear 413.
      if (input.length > RUN_INPUT_MAX_CHARS) throw new RunError("message_too_large");
      // A scheduled run the budget refuses is recorded as failed below (no retry storm, KOBE-174).
      const budgetBlocked = await this.#budgetBlocksSchedule(tx, actor, scheduled !== undefined);
      const parent = command.parent_entry_id ?? null;
      if (parent !== null && !(await entryExists(tx, teamId, thread.id, parent))) {
        throw new RunError("entry_not_found");
      }
      // The skipped-actions note is not in Pi's session: branching from it would fail the run.
      if (parent !== null && (await isSkippedSummaryEntry(tx, teamId, thread.id, parent))) {
        throw new RunError("invalid_parent_entry");
      }
      if ((await queuedCount(tx, teamId, thread.id)) >= this.#tuning.maxQueuedPerThread) {
        throw new RunError("queue_full");
      }
      const requested: ApprovalMode =
        command.trigger === "schedule" ? "auto" : (command.approval_mode ?? "ask-on-write");
      const approvalMode = clampApprovalMode(requested, await readApprovalFloor(tx));
      const id = await insertQueuedRun(tx, {
        teamId,
        threadId: thread.id,
        trigger: command.trigger,
        approvalMode,
        input,
        parentEntryId: parent,
        retryOfRunId: null,
        clientKey,
        viewing: command.resolvedViewing ?? null,
      });
      if (attach) {
        await this.#attachments?.commit(
          tx,
          attach.owner,
          attach.caller,
          thread.id,
          id,
          attach.staged,
        );
        onAttached();
      }
      await touchThread(tx, teamId, thread.id);
      if (budgetBlocked) {
        const run = await getRunRow(tx, teamId, id);
        if (!run) throw new Error("scheduled run vanished in its own transaction");
        const applied = await applyTransition(
          tx,
          thread,
          run,
          "failed",
          "error",
          failedEvent("budget_exhausted"),
        );
        await scheduled?.after(tx, { runId: id, budgetBlocked });
        return { result: { run_id: id, queued: false }, transitions: [applied.transition] };
      }
      // A user's new message releases a queue paused by Stop: it joins the end, earlier ones go
      // first. Scheduled runs (KOBE-64) queue behind a paused queue without releasing it.
      if (command.trigger === "user") await setQueuePaused(tx, teamId, thread.id, false);
      const { promotion, queued } = await this.#promoteOrQueue(tx, teamId, thread.id, id);
      await scheduled?.after(tx, { runId: id, budgetBlocked });
      return { result: { run_id: id, queued }, promotion };
    });
    if ("transitions" in out && out.transitions) this.#emit(teamId, out.transitions);
    if ("promotion" in out && out.promotion) this.#afterCommit(teamId, out.promotion);
    return out.result;
  }

  /**
   * The account check of a new run, plus the budget gate: a scheduled run the gate refuses is not
   * thrown away (that would be retried every tick) but reported to the caller to fail visibly.
   */
  async #budgetBlocksSchedule(
    tx: KobeTx,
    actor: ActorContext,
    scheduled: boolean,
  ): Promise<boolean> {
    try {
      await this.#assertMayRun(tx, actor);
      return false;
    } catch (err) {
      if (scheduled && err instanceof RunError && err.code === "budget_exhausted") return true;
      throw err;
    }
  }

  async steer(actor: ActorContext, runId: string, body: SteerBody): Promise<RunSnapshot> {
    // As for a send (re-review LOW-M): only the server writes app context or a skill line.
    if (imitatesAppContext(body.content) || imitatesSkillRequest(body.content)) {
      throw new RunError("invalid_content");
    }
    const { run, message } = await this.#threadTx(actor, async (tx, viewer) => {
      const found = await ownedRun(tx, viewer, runId, false);
      await this.#assertMayRun(tx, actor, false);
      return {
        run: found.run,
        message: (
          await rewriteMentions(
            tx,
            ownerOf(actor.team_id, found.thread),
            body.content,
            body.mentions ?? [],
          )
        ).text,
      };
    });
    // A compaction (KOBE-213) has no turn to steer.
    if (!isActiveRunStatus(run.status) || !isMessageRun(run)) {
      throw new RunError("invalid_transition", `A ${run.status} run can't be steered.`);
    }
    const outcome = await this.#router.steerRun(this.#target(actor.team_id, actor.user_id), {
      runId,
      threadId: run.threadId,
      message,
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
          payload: { content: message.slice(0, STEER_EVENT_MAX_CHARS) },
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
      const { thread, run } = await ownedRun(tx, viewer, runId, true);
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
      // Durable: if this replica dies before Pi is told, the sweep sends the abort.
      if (wasActive) await requestStop(tx, teamId, runId, "abort");
      // Stop pauses the queue behind the run (KOBE-26); deleting a queued message does not, nor
      // does stopping a compaction (KOBE-213): messages sent meanwhile were not stopped.
      const left = await queuedCount(tx, teamId, thread.id);
      const queuePaused = wasActive && left > 0 && isMessageRun(run);
      if (queuePaused) await setQueuePaused(tx, teamId, thread.id, true);
      // Deleting the last queued message leaves nothing to pause.
      if (!wasActive && left === 0) await setQueuePaused(tx, teamId, thread.id, false);
      await recordAudit(tx, {
        action: "run.cancelled",
        actor: userActor(actor),
        teamId,
        target: { runId, threadId: thread.id, wasActive, ...(queuePaused ? { queuePaused } : {}) },
      });
      return { wasActive, transition: applied.transition, threadId: thread.id };
    });
    if (result.transition) this.#emit(teamId, [result.transition]);
    if (result.wasActive && result.threadId !== undefined) {
      // Only the owner can Stop, and the sandbox is the owner's (D11).
      this.#track(
        this.#dispatch.stopThenAdvance({
          teamId,
          ownerUserId: actor.user_id,
          runId,
          threadId: result.threadId,
        }),
      );
    }
    return this.getRun(actor, runId);
  }

  async updateQueued(
    actor: ActorContext,
    runId: string,
    body: UpdateQueuedBody,
  ): Promise<RunSnapshot> {
    await this.#threadTx(actor, async (tx, viewer) => {
      const { thread, run } = await ownedRun(tx, viewer, runId, true);
      if (run.status !== "queued") {
        throw new RunError("invalid_transition", "Only queued messages can be edited.");
      }
      if (imitatesAppContext(body.content) || imitatesSkillRequest(body.content)) {
        throw new RunError("invalid_content");
      }
      const { text } = await rewriteMentions(
        tx,
        ownerOf(actor.team_id, thread),
        body.content,
        body.mentions ?? [],
      );
      // An edit changes the member's text only; the app context sent with it stays (LOW-E).
      const before = await tx.execute<{ input: string }>(sql`
        SELECT input FROM runs WHERE team_id = ${actor.team_id} AND id = ${runId}`);
      const old = before.rows[0]?.input ?? "";
      const kept = splitAppContext(old);
      // ... and so does the skill picked for it (KOBE-451).
      const skill = splitSkillRequest(kept.rest).skill;
      const own = skill === null ? text : withSkillRequest(skill, text);
      const input = kept.contexts.length > 0 ? old.slice(0, kept.restAt) + own : own;
      if (input.length > RUN_INPUT_MAX_CHARS) throw new RunError("message_too_large");
      await tx.execute(sql`
        UPDATE runs SET input = ${input} WHERE team_id = ${actor.team_id} AND id = ${runId}`);
      await touchThread(tx, actor.team_id, run.threadId);
    });
    return this.getRun(actor, runId);
  }

  async retry(actor: ActorContext, runId: string): Promise<SubmitMessageResult> {
    if (this.#isolation() === "missing") throw new RunError("isolation_unavailable");
    const teamId = actor.team_id;
    const out = await this.#threadTx(actor, async (tx, viewer) => {
      const { thread, run } = await ownedRun(tx, viewer, runId, true);
      if (thread.deletedAt !== null) throw new RunError("thread_in_trash");
      await this.#assertMayRun(tx, actor);
      const check = checkRetry(await retryCandidates(tx, teamId, thread.id), runId);
      if (check === "already_retried") {
        return { ...(await existingRetry(tx, teamId, runId)), promotion: undefined };
      }
      if (check === "not_interrupted") {
        throw new RunError("invalid_transition", "Only interrupted runs can be retried.");
      }
      if (check === "not_latest") {
        throw new RunError("invalid_transition", "Only the thread's latest run can be retried.");
      }
      // Retry resolves the interrupted state (D14); after "Continue without retry" it is gone.
      if (thread.status !== "interrupted") {
        throw new RunError(
          "invalid_transition",
          "Retry is only offered while the thread is interrupted.",
        );
      }
      const id = await insertQueuedRun(tx, {
        teamId,
        threadId: thread.id,
        trigger: run.trigger,
        // Re-clamped: a floor raised since the original run applies to its retry.
        approvalMode: clampApprovalMode(run.approvalMode, await readApprovalFloor(tx)),
        input: run.input,
        // Same branch point as the original: the retry is a sibling branch; history stays intact.
        parentEntryId: await retryBranchPoint(tx, teamId, run),
        retryOfRunId: runId,
        clientKey: null,
        // The retry sends what the member had open when they sent the original (KOBE-462 FE7).
        viewing: await runViewing(tx, teamId, runId),
      });
      await touchThread(tx, teamId, thread.id);
      const { promotion, queued } = await this.#promoteOrQueue(tx, teamId, thread.id, id);
      await recordAudit(tx, {
        action: "run.retried",
        actor: userActor(actor),
        teamId,
        target: { runId: id, threadId: thread.id, retryOfRunId: runId },
      });
      return { runId: id, queued, promotion };
    });
    if (out.promotion) this.#afterCommit(teamId, out.promotion);
    return { run_id: out.runId, queued: out.queued };
  }

  async resumeQueue(actor: ActorContext, threadId: string): Promise<void> {
    const promotion = await this.#threadTx(actor, async (tx, viewer) => {
      const thread = await lockOwnedThread(tx, viewer, threadId, "thread_not_found");
      const paused = await isQueuePaused(tx, actor.team_id, thread.id);
      if (thread.status !== "interrupted" && !paused) return undefined;
      if (paused) await setQueuePaused(tx, actor.team_id, thread.id, false);
      await touchThread(tx, actor.team_id, thread.id);
      await recordAudit(tx, {
        action: "run.queue_resumed",
        actor: userActor(actor),
        teamId: actor.team_id,
        target: { threadId: thread.id, wasInterrupted: thread.status === "interrupted" },
      });
      await setThreadStatus(
        tx,
        actor.team_id,
        thread.id,
        nextThreadStatus(thread.status, { kind: "queue_resumed" }),
      );
      return promoteInTx(tx, this.#agents, actor.team_id, thread.id, this.#hold);
    });
    if (promotion) this.#afterCommit(actor.team_id, promotion);
  }

  async reorderQueue(
    actor: ActorContext,
    threadId: string,
    runIds: readonly string[],
  ): Promise<void> {
    await this.#threadTx(actor, async (tx, viewer) => {
      const thread = await lockOwnedThread(tx, viewer, threadId, "thread_not_found");
      await reorderQueuedRuns(tx, actor.team_id, thread.id, runIds);
      await touchThread(tx, actor.team_id, thread.id);
      await recordAudit(tx, {
        action: "run.queue_reordered",
        actor: userActor(actor),
        teamId: actor.team_id,
        target: { threadId: thread.id, queued: runIds.length },
      });
    });
  }

  async pauseQueue(actor: ActorContext, threadId: string): Promise<void> {
    await this.#threadTx(actor, async (tx, viewer) => {
      const thread = await lockOwnedThread(tx, viewer, threadId, "thread_not_found");
      // A queued Retry still runs first while paused (D14, promotion): only messages wait.
      const waiting = await queuedMessageCount(tx, actor.team_id, thread.id);
      if (waiting === 0 || (await isQueuePaused(tx, actor.team_id, thread.id))) return;
      await setQueuePaused(tx, actor.team_id, thread.id, true);
      // Like every other queue change: the thread's activity moves, so other tabs read it again.
      await touchThread(tx, actor.team_id, thread.id);
      await recordAudit(tx, {
        action: "run.queue_paused",
        actor: userActor(actor),
        teamId: actor.team_id,
        target: { threadId: thread.id, queued: waiting },
      });
    });
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
    // A compaction in progress is not a turn (KOBE-213): the thread's status shows it.
    return rows.filter(isMessageRun).map(toSnapshot);
  }

  /**
   * The interrupted run an `interrupted` thread waits on (Retry or Continue, D14), so a client that
   * reloads can still offer Retry; null otherwise.
   */
  async latestInterruptedRun(actor: ActorContext, threadId: string): Promise<RunSnapshot | null> {
    const row = await this.#readTx(actor, async (tx, viewer) => {
      if (!(await findThread(tx, viewer, threadId))) throw new RunError("thread_not_found");
      return latestInterruptedRow(tx, actor.team_id, threadId);
    });
    return row ? toSnapshot(row) : null;
  }

  async queuePaused(actor: ActorContext, threadId: string): Promise<boolean> {
    return this.#readTx(actor, async (tx, viewer) => {
      if (!(await findThread(tx, viewer, threadId))) throw new RunError("thread_not_found");
      return (
        (await isQueuePaused(tx, actor.team_id, threadId)) &&
        (await queuedCount(tx, actor.team_id, threadId)) > 0
      );
    });
  }

  async compact(
    actor: ActorContext,
    threadId: string,
    focus?: string,
  ): Promise<CompactThreadResponse> {
    if (this.#isolation() === "missing") throw new RunError("isolation_unavailable");
    return compactThread(
      {
        db: this.#db,
        router: this.#router,
        agents: this.#agents,
        modelTokenDefaults: this.#modelTokenDefaults,
        log: this.#log,
        threadTx: (a, fn) => this.#threadTx(a, fn),
        assertMayRun: (tx, a) => this.#assertMayRun(tx, a),
        ended: (teamId, runId, id) => this.onRunEnded({ teamId, runId, threadId: id }),
        abort: (target) => this.#track(this.#dispatch.sendStop(target, "abort")),
      },
      actor,
      threadId,
      focus,
    );
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
          if (!isMessageRun(run)) {
            // A compaction has no step to finish (KOBE-213): it ends now and Pi aborts it.
            const applied = await applyTransition(
              tx,
              thread,
              run,
              "budget_stopped",
              "budget_exhausted",
              budgetStoppedEvent(command.scope),
            );
            await requestStop(tx, teamId, run.id, "abort");
            await recordAudit(tx, {
              action: "run.budget_stopped",
              actor: SYSTEM_ACTOR,
              teamId,
              target: { runId: run.id, threadId: thread.id, scope: command.scope },
            });
            return { transition: applied.transition, active: false, abort: true };
          }
          if (run.status === "queued") {
            const applied = await applyTransition(
              tx,
              thread,
              run,
              "budget_stopped",
              "budget_exhausted",
              budgetStoppedEvent(command.scope),
            );
            return { transition: applied.transition, active: false, abort: false };
          }
          // Already budget-stopping (the sweep re-sends its stop), or the user's own Stop is
          // pending (an abort is never downgraded to after-step): nothing to add (KOBE-42 review).
          if (run.budgetStopScope !== null) return undefined;
          const pending = await tx.execute<{ stop_mode: string | null }>(sql`
            SELECT stop_mode FROM runs WHERE team_id = ${teamId} AND id = ${run.id}`);
          if (pending.rows[0]?.stop_mode === "abort") return undefined;
          // Active: finish the current step (D30). The wire converts the settle into budget_stopped.
          await tx.execute(sql`
          UPDATE runs SET budget_stop_scope = ${command.scope}
           WHERE team_id = ${teamId} AND id = ${run.id}`);
          await requestStop(tx, teamId, run.id, "after_step");
          // D30: pending approvals expire, so the waiting call is denied and the step can finish.
          const expired = await expireRunApprovalsInTx(tx, teamId, run.id, "budget_exhausted");
          const resumed =
            expired.length > 0 && run.status === "waiting_approval"
              ? (await applyTransition(tx, thread, run, "running", "approval_resolved", undefined))
                  .transition
              : undefined;
          await auditExpiredApprovals(tx, teamId, expired);
          return { transition: resumed, active: true, abort: false };
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
      if (outcome.abort) {
        this.#track(
          this.#dispatch.stopThenAdvance({
            teamId,
            runId: c.id,
            threadId: c.thread_id,
            ownerUserId: c.owner_user_id,
          }),
        );
      }
      if (outcome.active) {
        this.#track(
          this.#dispatch.budgetStopActive(
            { teamId, runId: c.id, threadId: c.thread_id, ownerUserId: c.owner_user_id },
            command.scope,
          ),
        );
      }
    }
    if (failures > 0) {
      throw new Error(`budget stop: ${failures} run(s) could not be stopped; call again`);
    }
    return affected;
  }

  cancelScheduledRuns(
    teamId: string,
    userId: string,
    reason: ScheduledCancelReason,
  ): Promise<readonly string[]> {
    const ctx = {
      db: this.#db,
      withRetry: <T>(fn: () => Promise<T>) => this.#withRetry(fn),
      emit: (team: string, transitions: readonly AppliedTransition[]) =>
        this.#emit(team, transitions),
      stopThenAdvance: (target: StopTarget) => this.#track(this.#dispatch.stopThenAdvance(target)),
      log: this.#log,
    };
    return cancelScheduledRuns(ctx, teamId, userId, reason);
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
    const cause = WIRE_END_CAUSES[row.status as keyof typeof WIRE_END_CAUSES] ?? "error";
    this.#notify(row, {
      runId: row.id,
      threadId: row.threadId,
      from: "running",
      to: row.status,
      cause,
    });
  }

  useIsolation(probe: IsolationProbe): void {
    this.#isolation = probe;
  }

  useViewing(reader: ViewingReader): void {
    this.#viewing = reader;
  }

  useAttachments(stager: AttachmentStager): void {
    this.#attachments = stager;
  }

  async sweep(): Promise<RunSweepResult> {
    const result = await sweepRuns(this.#db, this.#tuning, this.#log);
    // Each finding is handled on its own: one failure never blocks the others.
    const each = async (what: string, id: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        this.#log.error({ err, id }, `run sweep: ${what} failed`);
      }
    };
    for (const lost of result.lostStarts) {
      await each("lost start", lost.runId, () => this.#dispatch.recoverStart(lost));
    }
    for (const stale of result.staleCompactions) {
      await each("stale compaction", stale.runId, () => this.#dispatch.failStaleCompaction(stale));
    }
    for (const stop of result.pendingStops) {
      // In the background: a stop waits for the sandbox's answer.
      this.#track(each("pending stop", stop.runId, () => this.#dispatch.recoverStop(stop)));
    }
    for (const t of result.stalledThreads) {
      await each("stalled queue", t.threadId, () => this.#advance(t.teamId, t.threadId));
    }
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
      projectIds: await viewerProjectIds(tx, actor.team_id, actor.user_id),
    };
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
  ): Promise<{ promotion: Promotion; queued: boolean }> {
    const promotion = await promoteInTx(tx, this.#agents, teamId, threadId, this.#hold);
    // Queued only if it really waits (a run can also fail in the same transaction).
    let queued = false;
    if (promotion.plan?.runId !== runId) {
      const row = await getRunRow(tx, teamId, runId);
      queued = row?.status === "queued";
      if (row?.status === "queued" && row.queueRank !== null) {
        await appendRunEventsInTx(tx, teamId, runId, [
          {
            type: "run.queued",
            payload: { thread_id: threadId, trigger: row.trigger, queue_pos: row.queueRank },
          },
        ]);
      }
    }
    return { promotion, queued };
  }

  #afterCommit(teamId: string, promotion: Promotion): void {
    this.#emit(teamId, promotion.transitions);
    if (promotion.plan) this.#track(this.#dispatch.start(promotion.plan));
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

  /** Starts the thread's next run if it may start; retried while the thread row is busy. */
  async #advance(teamId: string, threadId: string): Promise<void> {
    for (let attempt = 0; attempt < this.#tuning.advanceAttempts; attempt += 1) {
      if (this.#closed) return;
      try {
        const promotion = await withTeam(this.#db, teamId, async (tx) => {
          await setThreadLockTimeout(tx);
          return promoteInTx(tx, this.#agents, teamId, threadId, this.#hold);
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

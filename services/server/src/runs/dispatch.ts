import { isActiveRunStatus } from "@kobe/protocol";
import { SYSTEM_ACTOR, sql, type KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import { withAppendTx } from "../event-stream/append.js";
import type { CommandOutcome, SandboxRouter } from "../sandbox-wire/types.js";
import { budgetStoppedEvent, failedEvent, restartPlanInTx, type StartPlan } from "./lifecycle.js";
import type { RunAgentResolver } from "./seams.js";
import {
  applyTransition,
  clearStop,
  lockRunRow,
  lockThreadRow,
  requestStop,
  type AppliedTransition,
} from "./store.js";
import type { LostStart, PendingStop } from "./sweeper.js";

/** Timings the dispatcher uses (a subset of `RunTuning`). */
export interface DispatchTuning {
  readonly stopGraceMs: number;
  /** A lost start younger than this is re-sent; older ones fail `start_lost`. */
  readonly restartWindowMs: number;
  /** A pending stop older than this is given up (the sandbox is gone or never answers). */
  readonly stopGiveUpMs: number;
}

export interface DispatchHost {
  readonly db: KobeDb;
  readonly router: SandboxRouter;
  readonly agents: RunAgentResolver;
  readonly tuning: DispatchTuning;
  readonly log: Logger;
  closed(): boolean;
  emit(teamId: string, transitions: readonly AppliedTransition[]): void;
  advance(teamId: string, threadId: string): Promise<void>;
  track(task: Promise<unknown>): void;
}

export interface StopTarget {
  readonly teamId: string;
  readonly ownerUserId: string;
  readonly runId: string;
  readonly threadId: string;
}

/** Outcomes after which a stop is worth sending again (the sandbox may still run the run). */
const TRANSIENT = new Set(["timeout", "connection_lost", "unavailable"]);

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/**
 * Everything the orchestrator sends to sandboxes after a commit: `run.start`, Stop's abort, budget
 * stops. Each is backed by durable state written in the committing transaction (`running` run
 * without a lease; `runs.stop_mode`), so the sweep finishes the job when the replica that should
 * have sent it died (`recoverStart`, `recoverStop`).
 */
export class RunDispatcher {
  readonly #h: DispatchHost;

  constructor(host: DispatchHost) {
    this.#h = host;
  }

  /** Sends `run.start`; a start that no sandbox took fails the run here (KOBE-24 contract). */
  async start(plan: StartPlan): Promise<void> {
    const outcome = await this.#h.router.startRun(
      { teamId: plan.teamId, userId: plan.ownerUserId },
      {
        runId: plan.runId,
        threadId: plan.threadId,
        message: plan.input,
        ...(plan.attachments === undefined ? {} : { attachments: plan.attachments }),
        ...(plan.parentEntryId !== null ? { parentEntryId: plan.parentEntryId } : {}),
        config: {
          ...plan.config,
          agent:
            plan.agent === null || plan.agent.version === null
              ? null
              : { agent_id: plan.agent.agentId, version: plan.agent.version },
          approval_mode: plan.approvalMode,
        },
      },
    );
    if (outcome.ok || this.#h.closed()) return;
    this.#h.log.warn({ run_id: plan.runId, code: outcome.error.code }, "run.start failed");
    await this.#startFailed(plan, outcome.error.code);
  }

  /**
   * The wire already ended runs whose `run.start` the sandbox rejected. Without a lease nobody else
   * will end the run, so it fails here; with a lease the wire owns it (a reconnect resumes it, its
   * sweep interrupts it) — except after a timeout, when the sandbox holds the run but doesn't
   * answer: fail it and (durably) ask the sandbox to abort.
   */
  async #startFailed(plan: StartPlan, code: string): Promise<void> {
    const { db } = this.#h;
    const ended = await withAppendTx(db, plan.teamId, async (tx) => {
      const thread = await lockThreadRow(tx, plan.teamId, plan.threadId);
      const run = await lockRunRow(tx, plan.teamId, plan.runId);
      if (!thread || !run || !isActiveRunStatus(run.status)) return undefined;
      const lease = await tx.execute(sql`
        SELECT 1 FROM sandbox_run_leases WHERE team_id = ${plan.teamId} AND run_id = ${plan.runId}`);
      const leased = lease.rows.length > 0;
      if (leased && code !== "timeout") return undefined;
      const applied = await applyTransition(tx, thread, run, "failed", "error", failedEvent(code));
      if (leased) await requestStop(tx, plan.teamId, plan.runId, "abort");
      return { transition: applied.transition, leased };
    });
    if (!ended) return;
    this.#h.emit(plan.teamId, [ended.transition]);
    if (ended.leased) this.#h.track(this.sendStop(plan, "abort"));
    await this.#h.advance(plan.teamId, plan.threadId);
  }

  /**
   * Sends a pending stop (`runs.stop_mode`) and clears it once the sandbox answered. A sandbox
   * that is not connected is not woken for it: its next `hello` doesn't list ended runs, and the
   * agent aborts runs the server doesn't list (KOBE-24).
   */
  async sendStop(
    run: StopTarget,
    mode: "abort" | "after_step",
  ): Promise<CommandOutcome | undefined> {
    const { db, router } = this.#h;
    const target = { teamId: run.teamId, userId: run.ownerUserId };
    const clear = () =>
      withAppendTx(db, run.teamId, (tx) => clearStop(tx, run.teamId, run.runId, mode));
    if (!(await router.isConnected(target))) {
      await clear();
      return undefined;
    }
    const outcome = await router.stopRun(target, {
      runId: run.runId,
      threadId: run.threadId,
      mode,
      // The contract's reasons: a failed start's abort uses the closest one.
      reason: mode === "after_step" ? "budget_exhausted" : "user_cancelled",
    });
    if (!this.#h.closed() && (outcome.ok || !TRANSIENT.has(outcome.error.code))) await clear();
    return outcome;
  }

  /** Stop (D17): abort in the sandbox, then start the next queued run (after Pi's abort or a grace). */
  async stopThenAdvance(run: StopTarget): Promise<void> {
    const stop = this.sendStop(run, "abort");
    this.#h.track(stop);
    await Promise.race([stop, delay(this.#h.tuning.stopGraceMs)]);
    await this.#h.advance(run.teamId, run.threadId);
  }

  /** D30: let the current step finish, then end the run `budget_stopped` if Pi didn't settle it. */
  async budgetStopActive(run: StopTarget, scope: "install" | "team" | "user"): Promise<void> {
    await this.sendStop(run, "after_step");
    if (this.#h.closed()) return;
    await this.#endBudgetStopped(run, scope);
  }

  async #endBudgetStopped(run: StopTarget, scope: "install" | "team" | "user"): Promise<void> {
    const { teamId, runId, threadId } = run;
    const ended = await withAppendTx(this.#h.db, teamId, async (tx) => {
      const thread = await lockThreadRow(tx, teamId, threadId);
      const row = await lockRunRow(tx, teamId, runId);
      if (!thread || !row || !isActiveRunStatus(row.status)) return undefined;
      const applied = await applyTransition(
        tx,
        thread,
        row,
        "budget_stopped",
        "budget_exhausted",
        budgetStoppedEvent(scope),
      );
      await recordAudit(tx, {
        action: "run.budget_stopped",
        actor: SYSTEM_ACTOR,
        teamId,
        target: { runId, threadId, scope },
      });
      return applied.transition;
    });
    if (!ended) return;
    this.#h.emit(teamId, [ended]);
    await this.#h.advance(teamId, threadId);
  }

  /**
   * A `running` run whose `run.start` was never delivered (its replica died between commit and
   * send): re-send it while it is recent — no lease means no sandbox ever had it, so this cannot
   * run the prompt twice — else fail it `start_lost`.
   */
  async recoverStart(lost: LostStart): Promise<void> {
    const recent = lost.ageMs < this.#h.tuning.restartWindowMs;
    const out = await withAppendTx(this.#h.db, lost.teamId, async (tx) => {
      const thread = await lockThreadRow(tx, lost.teamId, lost.threadId);
      const run = await lockRunRow(tx, lost.teamId, lost.runId);
      if (!thread || !run || run.status !== "running") return undefined;
      const inFlight = await tx.execute(sql`
        SELECT 1 FROM sandbox_run_leases WHERE team_id = ${lost.teamId} AND run_id = ${lost.runId}
        UNION ALL
        SELECT 1 FROM sandbox_commands
         WHERE team_id = ${lost.teamId} AND run_id = ${lost.runId} AND kind = 'run.start'
           AND status IN ('pending', 'delivered')`);
      if (inFlight.rows.length > 0) return undefined;
      if (recent) {
        const plan = await restartPlanInTx(tx, this.#h.agents, thread, run);
        if (plan) return { plan };
      }
      const applied = await applyTransition(
        tx,
        thread,
        run,
        "failed",
        "error",
        failedEvent("start_lost"),
      );
      return { transition: applied.transition };
    });
    if (!out) return;
    if ("plan" in out) {
      this.#h.log.warn({ run_id: lost.runId }, "re-sending a lost run.start");
      this.#h.track(this.start(out.plan));
      return;
    }
    this.#h.emit(lost.teamId, [out.transition]);
    await this.#h.advance(lost.teamId, lost.threadId);
  }

  /** A stop whose sender died (or that the sandbox didn't answer): send it again, or give up. */
  async recoverStop(pending: PendingStop): Promise<void> {
    const run: StopTarget = pending;
    if (pending.ageMs > this.#h.tuning.stopGiveUpMs) {
      this.#h.log.warn({ run_id: pending.runId }, "giving up a stop the sandbox never answered");
      await withAppendTx(this.#h.db, pending.teamId, (tx) =>
        clearStop(tx, pending.teamId, pending.runId, pending.mode),
      );
      if (pending.mode === "after_step" && pending.budgetScope !== null) {
        await this.#endBudgetStopped(run, pending.budgetScope);
      }
      return;
    }
    if (pending.mode === "after_step" && pending.budgetScope !== null) {
      await this.budgetStopActive(run, pending.budgetScope);
      return;
    }
    await this.sendStop(run, pending.mode);
  }
}

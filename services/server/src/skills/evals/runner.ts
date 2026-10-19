import {
  and,
  eq,
  isNull,
  siteAgents,
  siteSkillSettings,
  sql,
  teams,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import {
  evalOutputWalkRoots,
  evalSnapshotResultSchema,
  fixtureWorkspacePath,
  skillEvalLimitsSchema,
  type ActorContext,
  type EvalWorkspaceSnapshot,
  type SkillEvalCase,
  type SkillEvalLimits,
} from "@kobe/protocol";
import { judgeOutputs } from "./judge-outputs.js";
import type { SkillEvalJudge } from "./judge.js";
import type { Logger } from "pino";
import { resolveAgentPin, type AgentPin } from "../../agents/versions.js";
import { KOBE_GALLERY_KEY } from "../../gallery/definitions.js";
import type { BlobStore } from "../../retention/blobs.js";
import type { ServerRunOrchestrator } from "../../runs/orchestrator.js";
import type { SandboxProvider } from "../../sandbox/provider.js";
import { liveConnection } from "../../sandbox-wire/commands.js";
import type { SandboxRouter, SandboxTarget } from "../../sandbox-wire/types.js";
import { messageText } from "../../threads/messages.js";
import { evalChecks, type EvalJudge, type EvalObservation } from "./checks.js";
import { errorAttempt, type EvalAttempt } from "./execution.js";
import { caseFixtureList, readFixtures } from "./storage.js";
import { BUDGET_FAILURES, REFUSED_BLOCK, evalBudgetBlock } from "./budget.js";
import {
  budgetStopEvalRun,
  claimNextExecution,
  evalRunOpen,
  hasQueuedExecution,
  heartbeat,
  markExecution,
  recordAttempt,
  requeueExecution,
  type ClaimedExecution,
} from "./store.js";

// The skill eval runner (KOBE-325, SK16). Every server replica sweeps: for each team with queued
// executions it claims as many as the team's cap allows (the claim is atomic across replicas) and
// runs each in its own ephemeral sandbox: create the claim `e-<thread>`, wait for its wire
// connection, copy the case's fixtures in, send the case's prompt as an ordinary run of the eval
// thread (auto mode; would-ask calls are denied), wait for the end (wall clock, cancel, turns),
// take the after-snapshot, make the checks, delete the sandbox, record the attempt (one retry in a
// new thread and sandbox). A replica that dies mid-execution leaves it to the reaper.

export interface SkillEvalRunnerTuning {
  /** How long a sandbox may take to have a pod (it may wait for the eval quota). */
  readonly podWaitMs: number;
  /** How long its agent may take to connect once the pod exists. */
  readonly connectWaitMs: number;
  readonly pollMs: number;
  /** The cluster deletes a claim this long after its execution's deadline (backstop). */
  readonly shutdownGraceMs: number;
  /** How often a running execution's heartbeat is written (the reaper waits for ~4 missed). */
  readonly heartbeatMs: number;
  /** Most executions this replica runs at once, across teams (review L8). */
  readonly maxActive: number;
}

export const SKILL_EVAL_RUNNER_TUNING: SkillEvalRunnerTuning = {
  podWaitMs: 3 * 60_000,
  connectWaitMs: 3 * 60_000,
  pollMs: 1_000,
  shutdownGraceMs: 5 * 60_000,
  heartbeatMs: 15_000,
  maxActive: 16,
};

export interface SkillEvalRunnerOptions {
  readonly db: KobeDb;
  readonly blobs: BlobStore;
  readonly router: SandboxRouter;
  readonly runs: Pick<ServerRunOrchestrator, "submitMessage" | "cancel">;
  readonly provider: Pick<SandboxProvider, "createEvalSandbox" | "deleteEvalSandbox">;
  /** The chart's `sandbox.skillEval.maxConcurrentPerTeam` (the eval quota's size). */
  readonly maxConcurrentPerTeam: number;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
  /** The judge (KOBE-326, `judge.ts`); absent: a `judge` check fails `judge_failed`. */
  readonly judge?: SkillEvalJudge;
  readonly tuning?: Partial<SkillEvalRunnerTuning>;
  /** How long a stale wire connection still counts as live (the wire's `staleConnectionMs`). */
  readonly staleConnectionMs?: number;
}

/** What an attempt has started so far (for cleanup when it fails). */
interface AttemptState {
  runId: string | null;
}

class EvalAbort extends Error {
  constructor(readonly reason: "cancelled" | "timeout" | "start" | "shutdown" | "budget") {
    super(reason);
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

const ownerActor = (teamId: string, userId: string): ActorContext => ({
  user_id: userId,
  team_id: teamId,
  site_role: "user",
  team_role: "member",
});

export class SkillEvalRunner {
  readonly #o: SkillEvalRunnerOptions;
  readonly #t: SkillEvalRunnerTuning;
  readonly #running = new Map<string, Promise<void>>();
  #closed = false;
  #sweeping: Promise<number> | undefined;

  constructor(options: SkillEvalRunnerOptions) {
    this.#o = options;
    this.#t = { ...SKILL_EVAL_RUNNER_TUNING, ...options.tuning };
  }

  /** Executions running on this replica. */
  get active(): number {
    return this.#running.size;
  }

  /** Claims and starts what the caps allow, in every team; resolves with how many started. */
  sweep(): Promise<number> {
    if (this.#closed) return Promise.resolve(0);
    this.#sweeping ??= this.#sweep().finally(() => {
      this.#sweeping = undefined;
    });
    return this.#sweeping;
  }

  /** Resolves when every execution started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running.values()]);
  }

  close(): void {
    this.#closed = true;
  }

  /**
   * Shutdown (review M2): no new claims, and every execution here stops now: its run is cancelled,
   * its sandbox deleted and it goes back to queued without using its attempt (another replica
   * runs it). Resolves once they are back, or after `timeoutMs` (the reaper finishes the rest).
   */
  async shutdown(timeoutMs: number): Promise<void> {
    this.#closed = true;
    await Promise.race([this.idle(), delay(timeoutMs)]);
  }

  async #sweep(): Promise<number> {
    const limits = await siteEvalLimits(this.#o.db);
    const cap = Math.min(limits.maxConcurrentSandboxes, this.#o.maxConcurrentPerTeam);
    const wallClockMs = limits.caseWallClockMinutes * 60_000;
    const all = await this.#o.db.select({ id: teams.id, slug: teams.slug }).from(teams);
    let started = 0;
    for (const team of all) {
      if (this.#running.size >= this.#t.maxActive) break;
      if (!(await hasQueuedExecution(this.#o.db, team.id).catch(() => false))) continue;
      for (;;) {
        if (this.#closed || this.#running.size >= this.#t.maxActive) return started;
        let claim: ClaimedExecution | null;
        try {
          claim = await claimNextExecution(this.#o.db, team.id, {
            cap,
            wallClockMs,
            pinFor: kobePin,
          });
        } catch (err) {
          this.#o.log.error({ err, team_id: team.id }, "skill evals: claim failed");
          break;
        }
        if (!claim) break;
        started += 1;
        const key = `${claim.teamId}:${claim.threadId}`;
        const task = this.#execute(team, claim).finally(() => this.#running.delete(key));
        this.#running.set(key, task);
      }
    }
    return started;
  }

  async #execute(team: { id: string; slug: string }, claim: ClaimedExecution): Promise<void> {
    const started = Date.now();
    const state: AttemptState = { runId: null };
    const beat = setInterval(() => {
      void heartbeat(this.#o.db, claim).catch(() => undefined);
    }, this.#t.heartbeatMs);
    beat.unref();
    let attempt: EvalAttempt | null;
    try {
      attempt = await this.#attempt(team, claim, started, state);
    } catch (err) {
      // A shutdown, or a budget stop (the eval run ended): back to queued, its attempt unused.
      const shutdown =
        err instanceof EvalAbort && (err.reason === "shutdown" || err.reason === "budget");
      if (!(err instanceof EvalAbort))
        this.#o.log.warn(
          { err, team_id: claim.teamId, eval_run_id: claim.evalRunId, case_id: claim.caseId },
          "skill evals: execution failed",
        );
      // A run started before the failure is stopped here, not left to the lost-run sweep (L9).
      if (state.runId)
        await this.#o.runs
          .cancel(ownerActor(claim.teamId, claim.userId), state.runId)
          .catch(() => undefined);
      attempt = shutdown ? null : errorAttempt(claim.threadId, state.runId, Date.now() - started);
    } finally {
      // Cleanup on every path (KOBE-325): the claim's shutdownTime and the reaper are backstops.
      await this.#o.provider
        .deleteEvalSandbox(team, claim.threadId)
        .catch((err: unknown) =>
          this.#o.log.warn(
            { err, thread_id: claim.threadId },
            "skill evals: sandbox delete failed",
          ),
        );
    }
    // D30 / SK18 (KOBE-327): an attempt that didn't pass because a budget or the team eval cap
    // is used up (the gateway refused its calls, or the budget monitor stopped its run) ends the
    // whole eval `budget_stopped`, with no retry; its result is then not recorded.
    if (attempt !== null && attempt.status !== "passed") await this.#stopIfBudget(claim);
    try {
      if (attempt === null) await requeueExecution(this.#o.db, claim);
      else await recordAttempt(this.#o.db, claim, attempt, claim.runModel);
    } catch (err) {
      this.#o.log.error({ err, eval_run_id: claim.evalRunId }, "skill evals: could not record");
    } finally {
      // Beating until the result is recorded: a slow sandbox delete never looks like a dead
      // replica to the reaper (re-review R4).
      clearInterval(beat);
    }
  }

  async #attempt(
    team: { id: string; slug: string },
    claim: ClaimedExecution,
    started: number,
    state: AttemptState,
  ): Promise<EvalAttempt> {
    const c = claim.suite.cases.find((x) => x.id === claim.caseId);
    if (!c) throw new Error(`the suite has no case ${claim.caseId}`);
    // Nothing starts once a budget or the team eval cap is used up (KOBE-327).
    if (await this.#stopIfBudget(claim)) throw new EvalAbort("budget");
    const target: SandboxTarget = {
      teamId: claim.teamId,
      userId: claim.userId,
      evalThreadId: claim.threadId,
    };
    const deadline = claim.deadlineAt.getTime();
    await this.#o.provider.createEvalSandbox(
      team,
      {
        userId: claim.userId,
        threadId: claim.threadId,
        evalRunId: claim.evalRunId,
        shutdownAt: new Date(deadline + this.#t.shutdownGraceMs),
      },
      Math.max(1_000, Math.min(this.#t.podWaitMs, deadline - Date.now())),
    );
    await this.#waitConnected(
      target,
      claim,
      Math.min(deadline, Date.now() + this.#t.connectWaitMs),
    );
    const fixtures = await this.#prepare(target, claim, c);
    const actor = ownerActor(claim.teamId, claim.userId);
    const submitted = await this.#o.runs.submitMessage(actor, {
      thread_id: claim.threadId,
      content: c.prompt,
      trigger: "user",
      approval_mode: "auto",
    });
    const runId = submitted.run_id;
    state.runId = runId;
    await markExecution(this.#o.db, claim, "running", runId);
    const end = await this.#waitRun(claim, runId, c.expect.max_turns, deadline);
    if (end !== "ended") {
      await this.#o.runs.cancel(actor, runId).catch(() => undefined);
      if (end === "cancelled" || end === "shutdown") {
        state.runId = null;
        throw new EvalAbort(end);
      }
    }
    const observed = await this.#observe(claim, runId);
    if (end === "timeout") {
      return {
        ...observed.numbers,
        status: "timed_out",
        checks: [],
        judgeCostUsd: 0,
        durationMs: Date.now() - started,
        threadId: claim.threadId,
        runId,
      };
    }
    await markExecution(this.#o.db, claim, "collecting");
    // The gateway refused the run's model calls for a budget or the team eval cap (spend plus
    // the calls in flight reached it, review-327 M1), or the budget monitor stopped the run: the
    // eval ends `budget_stopped`; this attempt is neither recorded, retried nor scored.
    if (observed.status === "budget_stopped" || BUDGET_FAILURES.has(observed.failureCode ?? "")) {
      await this.#stopForBudget(claim, true);
      throw new EvalAbort("budget");
    }
    if (observed.status !== "completed" && end !== "over_turns") {
      return {
        ...errorAttempt(claim.threadId, runId, Date.now() - started, observed.numbers.costUsd),
      };
    }
    const snapshot = c.expect.outputs ? await this.#snapshot(target, claim, c) : { walks: [] };
    const obs: EvalObservation = {
      answer: observed.answer,
      skillUses: claim.withSkill ? observed.numbers.skillUses : 0,
      costUsd: observed.numbers.costUsd,
      turns: observed.numbers.turns,
      overTurnLimit: end === "over_turns",
      deniedToolCalls: observed.numbers.deniedToolCalls,
      snapshot,
    };
    const judge = this.#judgeFor(target, claim, runId);
    const checked = await evalChecks(c, claim.withSkill, obs, fixtures, {
      ...(judge ? { judge } : {}),
    });
    // The judge's call was refused for a budget or the eval cap: the same stop, not a failure.
    if (checked.budgetRefused) {
      await this.#stopForBudget(claim, true);
      throw new EvalAbort("budget");
    }
    return {
      status: checked.status,
      checks: checked.checks,
      skillUses: obs.skillUses,
      costUsd: obs.costUsd,
      judgeCostUsd: checked.judgeCostUsd,
      durationMs: Date.now() - started,
      turns: obs.turns,
      deniedToolCalls: obs.deniedToolCalls,
      threadId: claim.threadId,
      runId,
    };
  }

  /** Ends the eval `budget_stopped` when a budget or the eval cap stops it; whether it did. */
  async #stopIfBudget(claim: ClaimedExecution): Promise<boolean> {
    return this.#stopForBudget(claim, false);
  }

  /**
   * `refused`: the gateway already refused a call (so the eval stops whatever the ledger says,
   * naming the line that spend plus the calls in flight reached, else a general reason).
   */
  async #stopForBudget(claim: ClaimedExecution, refused: boolean): Promise<boolean> {
    try {
      const block =
        (await evalBudgetBlock(this.#o.db, claim.teamId, claim.userId, { inFlight: refused })) ??
        (refused ? REFUSED_BLOCK : null);
      if (!block) return false;
      await budgetStopEvalRun(this.#o.db, claim.teamId, claim.evalRunId, block);
      return true;
    } catch (err) {
      this.#o.log.warn({ err, eval_run_id: claim.evalRunId }, "skill evals: budget check failed");
      return false;
    }
  }

  /**
   * This attempt's judge (KOBE-326): the matched outputs' bytes come from the sandbox
   * (`eval.read`: paths and walked sizes only go out), then one server-side call on the judge
   * model chosen at start. The runner keeps beating meanwhile (state `collecting`); the read and
   * the call each have their own timeout. Nothing of the judge's messages reaches the sandbox.
   */
  #judgeFor(target: SandboxTarget, claim: ClaimedExecution, runId: string): EvalJudge | undefined {
    const service = this.#o.judge;
    const model = claim.judgeModel;
    if (!service || !model) return undefined;
    return async (input) => {
      const outputs = await judgeOutputs(this.#o.router, target, claim.threadId, input.outputs);
      if (!outputs)
        return {
          kind: "failed",
          costUsd: 0,
          detail: "The outputs could not be read for the judge.",
        };
      return service.judge({
        teamId: claim.teamId,
        userId: claim.userId,
        threadId: claim.threadId,
        runId,
        judgeAlias: model.alias,
        rubric: input.rubric,
        prompt: input.prompt,
        answer: input.answer,
        outputs,
      });
    };
  }

  async #waitConnected(target: SandboxTarget, claim: ClaimedExecution, until: number) {
    const stale = this.#o.staleConnectionMs ?? 45_000;
    for (;;) {
      const live = await withTeam(this.#o.db, target.teamId, (tx) =>
        liveConnection(tx, target, stale),
      );
      if (live) return;
      if (this.#closed) throw new EvalAbort("shutdown");
      if (!(await evalRunOpen(this.#o.db, claim.teamId, claim.evalRunId)))
        throw new EvalAbort("cancelled");
      if (Date.now() >= until) throw new EvalAbort("start");
      await delay(this.#t.pollMs);
    }
  }

  /** The case's fixtures into the sandbox; what the checks compare the after-snapshot with. */
  async #prepare(target: SandboxTarget, claim: ClaimedExecution, c: SkillEvalCase) {
    if (c.files.length === 0) return [];
    if (!claim.fixturesKey) throw new Error("the eval has no stored fixtures");
    const stored = await readFixtures(this.#o.blobs, claim.fixturesKey);
    if (!stored) throw new Error("the eval's fixtures are missing");
    const files = caseFixtureList(stored, c.files);
    const out = await this.#o.router.evalPrepare(target, { threadId: claim.threadId, files });
    if (!out.ok) throw new Error(`eval.prepare: ${out.error.code}`);
    return files.map((f) => ({ path: f.path, sha256: f.sha256 }));
  }

  async #snapshot(
    target: SandboxTarget,
    claim: ClaimedExecution,
    c: SkillEvalCase,
  ): Promise<EvalWorkspaceSnapshot | null> {
    const out = await this.#o.router.evalSnapshot(target, {
      threadId: claim.threadId,
      roots: evalOutputWalkRoots(c.expect.outputs ?? []),
      hashPaths: c.files.map(fixtureWorkspacePath),
    });
    if (!out.ok) return null;
    const parsed = evalSnapshotResultSchema.safeParse(out.data);
    return parsed.success ? parsed.data : null;
  }

  /** Until the run ends, the deadline passes, the eval is cancelled or a turn past the limit. */
  async #waitRun(
    claim: ClaimedExecution,
    runId: string,
    maxTurns: number,
    deadline: number,
  ): Promise<"ended" | "timeout" | "cancelled" | "over_turns" | "shutdown"> {
    for (;;) {
      if (this.#closed) return "shutdown";
      const state = await withTeam(this.#o.db, claim.teamId, (tx) =>
        runState(tx, claim.teamId, runId),
      );
      if (state.ended) return "ended";
      if (state.turns > maxTurns) return "over_turns";
      if (Date.now() >= deadline) return "timeout";
      if (!(await evalRunOpen(this.#o.db, claim.teamId, claim.evalRunId))) return "cancelled";
      await delay(this.#t.pollMs);
    }
  }

  async #observe(claim: ClaimedExecution, runId: string) {
    return withTeam(this.#o.db, claim.teamId, async (tx) => {
      const run = await tx.execute<{ status: string; skills_used: { name?: string }[] }>(sql`
        SELECT status, skills_used FROM runs WHERE team_id = ${claim.teamId} AND id = ${runId}`);
      const usage = await tx.execute<{ cost: string | number | null; n: string | number }>(sql`
        SELECT coalesce(sum(cost_usd), 0) AS cost, count(*) AS n FROM run_usage
         WHERE team_id = ${claim.teamId} AND run_id = ${runId} AND kind IN ('run', 'eval')`);
      const denied = await tx.execute<{ n: string | number }>(sql`
        SELECT count(*) AS n FROM run_events
         WHERE team_id = ${claim.teamId} AND run_id = ${runId} AND type = 'policy.denied'`);
      const failed = await tx.execute<{ code: string | null }>(sql`
        SELECT payload -> 'error' ->> 'code' AS code FROM run_events
         WHERE team_id = ${claim.teamId} AND run_id = ${runId} AND type = 'run.failed'
         ORDER BY seq DESC LIMIT 1`);
      const answers = await tx.execute<{ content: unknown }>(sql`
        SELECT payload -> 'message' -> 'content' AS content FROM thread_entries
         WHERE team_id = ${claim.teamId} AND thread_id = ${claim.threadId} AND type = 'message'
           AND payload -> 'message' ->> 'role' = 'assistant'
         ORDER BY seq DESC LIMIT 8`);
      const answer = answers.rows.map((r) => messageText(r.content)).find((t) => t.trim() !== "");
      const used = run.rows[0]?.skills_used ?? [];
      return {
        status: run.rows[0]?.status ?? "failed",
        failureCode: failed.rows[0]?.code ?? null,
        answer: answer ?? "",
        numbers: {
          // The run's only skill is the eval's (withSkillEvals): a read of its SKILL.md.
          skillUses: used.filter((u) => u.name === claim.skillName).length,
          costUsd: Math.round(Number(usage.rows[0]?.cost ?? 0) * 1e6) / 1e6,
          turns: Number(usage.rows[0]?.n ?? 0),
          deniedToolCalls: Number(denied.rows[0]?.n ?? 0),
        },
      };
    });
  }
}

async function runState(tx: KobeTx, teamId: string, runId: string) {
  const res = await tx.execute<{ ended: boolean; turns: string | number }>(sql`
    SELECT r.status NOT IN ('queued', 'running', 'waiting_approval') AS ended,
           (SELECT count(*) FROM run_usage u
             WHERE u.team_id = r.team_id AND u.run_id = r.id AND u.kind IN ('run', 'eval')) AS turns
      FROM runs r WHERE r.team_id = ${teamId} AND r.id = ${runId}`);
  const row = res.rows[0];
  return { ended: row?.ended ?? true, turns: Number(row?.turns ?? 0) };
}

/** The Site's eval limits (`site_skill_settings.eval_limits`), defaults filled in. */
export async function siteEvalLimits(db: KobeDb): Promise<SkillEvalLimits> {
  const [row] = await db.select({ limits: siteSkillSettings.evalLimits }).from(siteSkillSettings);
  const parsed = skillEvalLimitsSchema.safeParse(row?.limits ?? {});
  return parsed.success ? parsed.data : skillEvalLimitsSchema.parse({});
}

/** The Kobe gallery agent's pin, as Workbench test chats use it. */
export async function kobePin(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<AgentPin | null> {
  const [kobe] = await tx
    .select({ id: siteAgents.id })
    .from(siteAgents)
    .where(
      and(
        eq(siteAgents.scope, "gallery"),
        eq(siteAgents.galleryKey, KOBE_GALLERY_KEY),
        isNull(siteAgents.archivedAt),
      ),
    );
  if (!kobe) return null;
  const pin = await resolveAgentPin(tx, { teamId, userId }, kobe.id);
  return pin.ok ? pin.value : null;
}

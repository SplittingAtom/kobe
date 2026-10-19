import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import {
  computeSkillEvalScorecard,
  skillEvalExecutionSchema,
  skillEvalSuiteSchema,
  type SkillEvalExecution,
  type SkillEvalJudgeModel,
  type SkillEvalMode,
  type SkillEvalRunModel,
  type SkillEvalSuite,
} from "@kobe/protocol";
import { createThread } from "../../threads/repository.js";
import type { AgentPin } from "../../agents/versions.js";
import { executionFromAttempts, retries, type EvalAttempt } from "./execution.js";

// The skill eval queue in Postgres (KOBE-325): eval runs, their executions and every state change.
// Postgres is the record; `NOTIFY kobe_skill_eval '<team>:<eval run>'` is only a hint (events).
// Concurrency per team is decided under a transaction advisory lock on the team, so replicas
// never start more than the cap between them.

export const SKILL_EVAL_CHANNEL = "kobe_skill_eval";
const ACTIVE = sql.raw(`('starting', 'running', 'collecting')`);
const OPEN = sql.raw(`('queued', 'running')`);

export async function notifyEval(tx: KobeTx, teamId: string, evalRunId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_notify(${SKILL_EVAL_CHANNEL}, ${`${teamId}:${evalRunId}`})`);
}

export interface NewEvalRun {
  readonly teamId: string;
  readonly id: string;
  readonly startedBy: string;
  readonly subject: {
    readonly kind: "draft" | "team" | "personal";
    readonly id: string;
    readonly rev: number;
  };
  readonly skillName: string;
  readonly packageHash: string;
  readonly runtimeHash: string;
  readonly bundleKey: string;
  readonly bundleSize: number;
  readonly fixturesKey: string | null;
  readonly mode: SkillEvalMode;
  readonly suite: SkillEvalSuite;
  readonly limits: Record<string, unknown>;
  readonly runModel: SkillEvalRunModel;
  readonly judgeModel: SkillEvalJudgeModel | null;
  readonly plan: readonly { readonly caseId: string; readonly withSkill: boolean }[];
}

/**
 * The suite as stored: what `skillEvalSuiteSchema` parses back to the same suite (a case without
 * fixtures leaves `files` out, as the file did; the parser's defaults fill it in again).
 */
export function storedSuite(suite: SkillEvalSuite): Record<string, unknown> {
  return {
    ...suite,
    cases: suite.cases.map(({ files, ...c }) => (files.length > 0 ? { ...c, files } : c)),
  };
}

/** Inserts the run and one queued result per planned execution. */
export async function insertEvalRun(tx: KobeTx, r: NewEvalRun): Promise<void> {
  await tx.execute(sql`
    INSERT INTO skill_eval_runs (team_id, id, started_by, subject_kind, subject_id, subject_rev,
      skill_name, package_hash, runtime_hash, bundle_key, bundle_size, fixtures_key, mode, suite,
      limits, run_model, judge_model, progress_total)
    VALUES (${r.teamId}, ${r.id}, ${r.startedBy}, ${r.subject.kind}, ${r.subject.id},
      ${r.subject.rev}, ${r.skillName}, ${r.packageHash}, ${r.runtimeHash}, ${r.bundleKey},
      ${r.bundleSize}, ${r.fixturesKey}, ${r.mode}, ${JSON.stringify(storedSuite(r.suite))}::jsonb,
      ${JSON.stringify(r.limits)}::jsonb, ${JSON.stringify(r.runModel)}::jsonb,
      ${r.judgeModel === null ? null : JSON.stringify(r.judgeModel)}::jsonb, ${r.plan.length})`);
  for (const p of r.plan) {
    await tx.execute(sql`
      INSERT INTO skill_eval_results (team_id, eval_run_id, case_id, with_skill)
      VALUES (${r.teamId}, ${r.id}, ${p.caseId}, ${p.withSkill})`);
  }
  await notifyEval(tx, r.teamId, r.id);
}

/** One execution a replica took to run now. */
export interface ClaimedExecution {
  readonly teamId: string;
  readonly evalRunId: string;
  readonly caseId: string;
  readonly withSkill: boolean;
  readonly attempt: 1 | 2;
  readonly userId: string;
  readonly threadId: string;
  readonly deadlineAt: Date;
  readonly firstAttempt: EvalAttempt | null;
  readonly suite: SkillEvalSuite;
  readonly fixturesKey: string | null;
  readonly runtimeHash: string;
  readonly skillName: string;
  readonly runModel: SkillEvalRunModel;
}

/** Whether the team has any queued execution (a cheap look before taking the team's lock). */
export async function hasQueuedExecution(db: KobeDb, teamId: string): Promise<boolean> {
  return withTeam(db, teamId, async (tx) => {
    const res = await tx.execute(sql`
      SELECT 1 FROM skill_eval_results WHERE team_id = ${teamId} AND state = 'queued' LIMIT 1`);
    return res.rows.length > 0;
  });
}

/**
 * Takes the next queued execution of an open eval run in the team (starters with the fewest
 * active executions first, then the oldest eval: one member's backlog never blocks the others'), if fewer than `cap` of the
 * team's executions are active: under the team's transaction advisory lock (every replica counts
 * and claims in turn), so the cap holds across replicas. The execution gets a new eval thread
 * (the Kobe agent `pin`, the run's model), its wall-clock deadline and state `starting`.
 */
export async function claimNextExecution(
  db: KobeDb,
  teamId: string,
  opts: {
    readonly cap: number;
    /** Used when the eval run stored no wall clock (it normally keeps the one it started with). */
    readonly wallClockMs: number;
    /** The Kobe agent's pin for the eval's thread (null: unavailable, the eval run fails). */
    readonly pinFor: (tx: KobeTx, teamId: string, userId: string) => Promise<AgentPin | null>;
  },
): Promise<ClaimedExecution | null> {
  return withTeam(db, teamId, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kobe.skill-eval:${teamId}`}, 0))`,
    );
    const active = await tx.execute<{ n: number | string }>(sql`
      SELECT count(*) AS n FROM skill_eval_results WHERE team_id = ${teamId} AND state IN ${ACTIVE}`);
    if (Number(active.rows[0]?.n ?? 0) >= opts.cap) return null;
    const next = await tx.execute<{
      eval_run_id: string;
      case_id: string;
      with_skill: boolean;
      attempt: number;
      first_attempt: EvalAttempt | null;
      started_by: string;
      suite: unknown;
      fixtures_key: string | null;
      runtime_hash: string;
      skill_name: string;
      run_model: SkillEvalRunModel;
      wall_minutes: number | null;
    }>(sql`
      SELECT x.eval_run_id, x.case_id, x.with_skill, x.attempt, x.first_attempt, r.started_by,
             r.suite, r.fixtures_key, r.runtime_hash, r.skill_name, r.run_model,
             (r.limits ->> 'caseWallClockMinutes')::int AS wall_minutes
        FROM skill_eval_results x
        JOIN skill_eval_runs r ON r.team_id = x.team_id AND r.id = x.eval_run_id
        -- Only a starter who is still an active member of the team (review L8).
        JOIN team_members m ON m.team_id = r.team_id AND m.user_id = r.started_by
        JOIN users u ON u.id = r.started_by AND u.deactivated_at IS NULL
       WHERE x.team_id = ${teamId} AND x.state = 'queued' AND r.status IN ${OPEN}
         AND r.cancel_requested_at IS NULL
       ORDER BY (SELECT count(*) FROM skill_eval_results a
                   JOIN skill_eval_runs ar ON ar.team_id = a.team_id AND ar.id = a.eval_run_id
                  WHERE a.team_id = x.team_id AND a.state IN ${ACTIVE}
                    AND ar.started_by = r.started_by),
                r.started_at, r.id, x.case_id, x.with_skill DESC
       LIMIT 1
       FOR UPDATE OF x SKIP LOCKED`);
    const row = next.rows[0];
    if (!row) return null;
    const pin = await opts.pinFor(tx, teamId, row.started_by);
    if (!pin) {
      await tx.execute(sql`
        UPDATE skill_eval_runs
           SET status = 'failed', finished_at = now(), updated_at = now(),
               failure = ${JSON.stringify({ code: "agent_unavailable", message: "The Kobe agent is not available." })}::jsonb
         WHERE team_id = ${teamId} AND id = ${row.eval_run_id} AND status IN ${OPEN}`);
      await notifyEval(tx, teamId, row.eval_run_id);
      return null;
    }
    const thread = await createThread(tx, {
      teamId,
      ownerUserId: row.started_by,
      projectId: null,
      agent: pin,
      skillEvalRunId: row.eval_run_id,
      title: `Eval ${row.case_id}${row.with_skill ? "" : " (baseline)"}`,
      modelAlias: row.run_model.used,
    });
    const deadline = await tx.execute<{ deadline_at: Date | string }>(sql`
      UPDATE skill_eval_results
         SET state = 'starting', thread_id = ${thread.thread_id}, run_id = NULL,
             deadline_at = now() + make_interval(secs => ${
               row.wall_minutes ? row.wall_minutes * 60 : opts.wallClockMs / 1000
             }),
             started_at = coalesce(started_at, now()), updated_at = now()
       WHERE team_id = ${teamId} AND eval_run_id = ${row.eval_run_id}
         AND case_id = ${row.case_id} AND with_skill = ${row.with_skill}
      RETURNING deadline_at`);
    await tx.execute(sql`
      UPDATE skill_eval_runs SET status = 'running', updated_at = now()
       WHERE team_id = ${teamId} AND id = ${row.eval_run_id} AND status = 'queued'`);
    await notifyEval(tx, teamId, row.eval_run_id);
    return {
      teamId,
      evalRunId: row.eval_run_id,
      caseId: row.case_id,
      withSkill: row.with_skill,
      attempt: row.attempt === 2 ? 2 : 1,
      userId: row.started_by,
      threadId: thread.thread_id,
      deadlineAt: new Date(deadline.rows[0]?.deadline_at ?? Date.now()),
      firstAttempt: row.first_attempt,
      suite: skillEvalSuiteSchema.parse(row.suite),
      fixturesKey: row.fixtures_key,
      runtimeHash: row.runtime_hash,
      skillName: row.skill_name,
      runModel: row.run_model,
    };
  });
}

type ExecutionKey = Pick<
  ClaimedExecution,
  "teamId" | "evalRunId" | "caseId" | "withSkill" | "threadId"
>;

const keyOf = (e: ExecutionKey) => sql`team_id = ${e.teamId} AND eval_run_id = ${e.evalRunId}
  AND case_id = ${e.caseId} AND with_skill = ${e.withSkill} AND thread_id = ${e.threadId}`;

/**
 * The running replica's heartbeat (review M2): the reaper takes over an execution whose heartbeat
 * stopped (its replica died), never one whose runner is still working, deadline or not.
 */
export async function heartbeat(db: KobeDb, e: ExecutionKey): Promise<boolean> {
  return withTeam(db, e.teamId, async (tx) => {
    const res = await tx.execute(sql`
      UPDATE skill_eval_results SET updated_at = now() WHERE ${keyOf(e)} AND state IN ${ACTIVE}`);
    return res.rowCount === 1;
  });
}

/**
 * The reaper's claim on a silent execution (re-review R4): only if its heartbeat is still older
 * than `silentSec` now, in one guarded update that counts the takeover and resets the heartbeat (a
 * runner that beat meanwhile keeps it; a second reaper pass waits again). What it needs next.
 */
export async function claimTakeover(
  db: KobeDb,
  e: ExecutionKey,
  silentSec: number,
): Promise<{
  takeovers: number;
  attempt: 1 | 2;
  firstAttempt: EvalAttempt | null;
  model: string;
} | null> {
  return withTeam(db, e.teamId, async (tx) => {
    const res = await tx.execute<{
      takeovers: number;
      attempt: number;
      first_attempt: EvalAttempt | null;
      model: string;
    }>(sql`
      UPDATE skill_eval_results x
         SET takeovers = least(x.takeovers + 1, 100), updated_at = now()
        FROM skill_eval_runs r
       WHERE x.team_id = ${e.teamId} AND x.eval_run_id = ${e.evalRunId}
         AND x.case_id = ${e.caseId} AND x.with_skill = ${e.withSkill}
         AND x.thread_id = ${e.threadId} AND x.state IN ${ACTIVE}
         AND x.updated_at < now() - make_interval(secs => ${silentSec})
         AND r.team_id = x.team_id AND r.id = x.eval_run_id
      RETURNING x.takeovers, x.attempt, x.first_attempt, r.run_model ->> 'used' AS model`);
    const row = res.rows[0];
    return row
      ? {
          takeovers: row.takeovers,
          attempt: row.attempt === 2 ? 2 : 1,
          firstAttempt: row.first_attempt,
          model: row.model,
        }
      : null;
  });
}

/**
 * Puts an execution back to queued without using up its attempt (a shutdown or a dead replica:
 * an infrastructure event, never the skill's result). Its thread stays as history.
 */
export async function requeueExecution(db: KobeDb, e: ExecutionKey): Promise<boolean> {
  return withTeam(db, e.teamId, async (tx) => {
    const res = await tx.execute(sql`
      UPDATE skill_eval_results
         SET state = 'queued', thread_id = NULL, run_id = NULL, deadline_at = NULL, updated_at = now()
       WHERE ${keyOf(e)} AND state IN ${ACTIVE}`);
    if (res.rowCount === 1) await notifyEval(tx, e.teamId, e.evalRunId);
    return res.rowCount === 1;
  });
}

/** The execution's state moves on (only while it is still this attempt's). */
export async function markExecution(
  db: KobeDb,
  e: Pick<ClaimedExecution, "teamId" | "evalRunId" | "caseId" | "withSkill" | "threadId">,
  state: "running" | "collecting",
  runId?: string,
): Promise<boolean> {
  return withTeam(db, e.teamId, async (tx) => {
    const res = await tx.execute(sql`
      UPDATE skill_eval_results
         SET state = ${state}, run_id = coalesce(${runId ?? null}::uuid, run_id), updated_at = now()
       WHERE team_id = ${e.teamId} AND eval_run_id = ${e.evalRunId} AND case_id = ${e.caseId}
         AND with_skill = ${e.withSkill} AND thread_id = ${e.threadId} AND state IN ${ACTIVE}`);
    return res.rowCount === 1;
  });
}

/** Whether the eval run was cancelled (or ended) under a running execution. */
export async function evalRunOpen(db: KobeDb, teamId: string, evalRunId: string): Promise<boolean> {
  return withTeam(db, teamId, async (tx) => {
    const res = await tx.execute(sql`
      SELECT 1 FROM skill_eval_runs
       WHERE team_id = ${teamId} AND id = ${evalRunId} AND status IN ${OPEN}
         AND cancel_requested_at IS NULL`);
    return res.rows.length > 0;
  });
}

export type RecordOutcome = "retry" | "done" | "completed" | "stale";

/**
 * Records a finished attempt of the execution whose current thread is `threadId`: the one retry
 * (queued again, a new thread and sandbox next time) or its final execution; the eval run's
 * progress; and, once every execution is done, the scorecard (the run completes). An attempt of a
 * run that was cancelled meanwhile is put back to queued (never scored). Locks the run, then the
 * result.
 */
export async function recordAttempt(
  db: KobeDb,
  e: Pick<
    ClaimedExecution,
    "teamId" | "evalRunId" | "caseId" | "withSkill" | "threadId" | "attempt" | "firstAttempt"
  >,
  attempt: EvalAttempt,
  model: string,
): Promise<RecordOutcome> {
  return withTeam(db, e.teamId, async (tx) => {
    const run = await tx.execute<{ status: string; cancel_requested_at: Date | null }>(sql`
      SELECT status, cancel_requested_at FROM skill_eval_runs
       WHERE team_id = ${e.teamId} AND id = ${e.evalRunId} FOR UPDATE`);
    const r = run.rows[0];
    const key = sql`team_id = ${e.teamId} AND eval_run_id = ${e.evalRunId}
      AND case_id = ${e.caseId} AND with_skill = ${e.withSkill} AND thread_id = ${e.threadId}`;
    if (!r || r.status !== "running" || r.cancel_requested_at !== null) {
      await tx.execute(sql`
        UPDATE skill_eval_results
           SET state = 'queued', thread_id = NULL, run_id = NULL, deadline_at = NULL, updated_at = now()
         WHERE ${key} AND state IN ${ACTIVE}`);
      return "stale";
    }
    if (retries(attempt, e.attempt)) {
      const res = await tx.execute(sql`
        UPDATE skill_eval_results
           SET state = 'queued', attempt = 2, first_attempt = ${JSON.stringify(attempt)}::jsonb,
               thread_id = NULL, run_id = NULL, deadline_at = NULL, updated_at = now()
         WHERE ${key} AND state IN ${ACTIVE}`);
      await notifyEval(tx, e.teamId, e.evalRunId);
      return res.rowCount === 1 ? "retry" : "stale";
    }
    const attempts =
      e.attempt === 2 && e.firstAttempt
        ? ([e.firstAttempt, attempt] as const)
        : ([attempt] as const);
    const execution = executionFromAttempts(e.caseId, e.withSkill, model, attempts);
    const done = await tx.execute(sql`
      UPDATE skill_eval_results
         SET state = 'done', execution = ${JSON.stringify(execution)}::jsonb, finished_at = now(),
             deadline_at = NULL, updated_at = now()
       WHERE ${key} AND state IN ${ACTIVE}`);
    if (done.rowCount !== 1) return "stale";
    await tx.execute(sql`
      UPDATE skill_eval_runs SET progress_done = progress_done + 1, updated_at = now()
       WHERE team_id = ${e.teamId} AND id = ${e.evalRunId}`);
    await notifyEval(tx, e.teamId, e.evalRunId);
    return (await completeIfDone(tx, e.teamId, e.evalRunId)) ? "completed" : "done";
  });
}

/** Scores and completes the eval run once every execution is done (in the caller's lock). */
async function completeIfDone(tx: KobeTx, teamId: string, evalRunId: string): Promise<boolean> {
  const rows = await tx.execute<{ state: string; execution: unknown }>(sql`
    SELECT state, execution FROM skill_eval_results
     WHERE team_id = ${teamId} AND eval_run_id = ${evalRunId}`);
  if (rows.rows.some((r) => r.state !== "done")) return false;
  const run = await tx.execute<{
    suite: unknown;
    mode: SkillEvalMode;
    package_hash: string;
    run_model: SkillEvalRunModel;
    judge_model: SkillEvalJudgeModel | null;
    started_at: Date | string;
  }>(sql`
    SELECT suite, mode, package_hash, run_model, judge_model, started_at FROM skill_eval_runs
     WHERE team_id = ${teamId} AND id = ${evalRunId}`);
  const r = run.rows[0];
  if (!r) return false;
  const executions: SkillEvalExecution[] = rows.rows.map((x) =>
    skillEvalExecutionSchema.parse(x.execution),
  );
  const card = computeSkillEvalScorecard({
    suite: skillEvalSuiteSchema.parse(r.suite),
    mode: r.mode,
    packageHash: r.package_hash,
    runModel: r.run_model,
    judgeModel: r.judge_model,
    executions,
    startedAt: new Date(r.started_at).toISOString(),
    completedAt: new Date().toISOString(),
  });
  await tx.execute(sql`
    UPDATE skill_eval_runs
       SET status = 'completed', scorecard = ${JSON.stringify(card)}::jsonb, finished_at = now(),
           updated_at = now()
     WHERE team_id = ${teamId} AND id = ${evalRunId} AND status = 'running'`);
  await notifyEval(tx, teamId, evalRunId);
  return true;
}

/**
 * Cancels an open eval run (its starter's request, offboarding): no new execution starts, the
 * running ones are stopped by their replica (or the reaper) and put back; done ones stay as
 * partial results. Returns whether it was open.
 */
export async function cancelEvalRun(
  tx: KobeTx,
  teamId: string,
  evalRunId: string,
): Promise<boolean> {
  const res = await tx.execute(sql`
    UPDATE skill_eval_runs
       SET status = 'cancelled', cancel_requested_at = now(), finished_at = now(), updated_at = now()
     WHERE team_id = ${teamId} AND id = ${evalRunId} AND status IN ${OPEN}`);
  if (res.rowCount === 1) await notifyEval(tx, teamId, evalRunId);
  return res.rowCount === 1;
}

/**
 * Cancels the open eval runs whose starter is no longer an active member of the team (re-review
 * R3): offboarding may have missed them (no sandbox in that team, a failed step); the runner
 * never starts them, so they would hold the team's open-eval slots for good.
 */
export async function cancelDepartedStartersEvals(db: KobeDb, teamId: string): Promise<number> {
  return withTeam(db, teamId, async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`
      UPDATE skill_eval_runs r
         SET status = 'cancelled', cancel_requested_at = now(), finished_at = now(),
             updated_at = now()
       WHERE r.team_id = ${teamId} AND r.status IN ${OPEN}
         AND NOT EXISTS (
           SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id
            WHERE m.team_id = r.team_id AND m.user_id = r.started_by
              AND u.deactivated_at IS NULL)
      RETURNING r.id`);
    for (const row of res.rows) await notifyEval(tx, teamId, row.id);
    return res.rows.length;
  });
}

/** Fails an open eval run that cannot go on (its package is unreadable, a model is gone). */
export async function failEvalRun(
  db: KobeDb,
  teamId: string,
  evalRunId: string,
  failure: { readonly code: string; readonly message: string },
): Promise<void> {
  await withTeam(db, teamId, async (tx) => {
    const res = await tx.execute(sql`
      UPDATE skill_eval_runs
         SET status = 'failed', failure = ${JSON.stringify(failure)}::jsonb, finished_at = now(),
             updated_at = now()
       WHERE team_id = ${teamId} AND id = ${evalRunId} AND status IN ${OPEN}`);
    if (res.rowCount === 1) await notifyEval(tx, teamId, evalRunId);
  });
}

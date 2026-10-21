import { readBudgetStopScope, sql, teams, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import type { Logger } from "pino";

/** A `running` run with no lease and no start (`run.start`, `thread.compact`) in flight. */
export interface LostStart {
  readonly teamId: string;
  readonly runId: string;
  readonly threadId: string;
  /** Since the run started. */
  readonly ageMs: number;
}

/** A stop the sandbox has not answered (`runs.stop_mode`) and no `run.stop` is in flight. */
export interface PendingStop {
  readonly teamId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly ownerUserId: string;
  readonly mode: "abort" | "after_step";
  readonly budgetScope: "site" | "team" | "user" | null;
  /** Since the stop was requested. */
  readonly ageMs: number;
}

export interface RunSweepResult {
  readonly lostStarts: readonly LostStart[];
  /** Compaction runs older than their deadline (KOBE-213): their requester is gone. */
  readonly staleCompactions: readonly StaleCompaction[];
  readonly pendingStops: readonly PendingStop[];
  /** Threads with queued runs and nothing active for a while (a promotion was lost). */
  readonly stalledThreads: readonly { readonly teamId: string; readonly threadId: string }[];
  readonly failedTeams: number;
}

/** A compaction run still active past `compactionDeadlineMs` (KOBE-213). */
export interface StaleCompaction {
  readonly teamId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly ownerUserId: string;
}

export interface SweepTuning {
  readonly startDeadlineMs: number;
  /** Longer than a compaction's whole command deadline (wake + Pi's 10 min). */
  readonly compactionDeadlineMs: number;
  readonly stallMs: number;
  readonly stopResendMs: number;
}

const secs = (ms: number) => ms / 1000;

async function lostStarts(tx: KobeTx, teamId: string, deadlineMs: number): Promise<LostStart[]> {
  const res = await tx.execute<{ id: string; thread_id: string; age_ms: string | number }>(sql`
    SELECT r.id, r.thread_id, extract(epoch FROM now() - r.started_at) * 1000 AS age_ms
      FROM runs r
     WHERE r.team_id = ${teamId} AND r.status = 'running'
       AND r.started_at < now() - make_interval(secs => ${secs(deadlineMs)})
       AND NOT EXISTS (SELECT 1 FROM sandbox_run_leases l
                        WHERE l.team_id = r.team_id AND l.run_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM sandbox_commands c
                        WHERE c.team_id = r.team_id AND c.run_id = r.id
                          AND c.kind IN ('run.start', 'thread.compact', 'notebook.execute')
                          AND c.status IN ('pending', 'delivered'))`);
  return res.rows.map((r) => ({
    teamId,
    runId: r.id,
    threadId: r.thread_id,
    ageMs: Number(r.age_ms),
  }));
}

/**
 * Compaction runs active past their deadline (KOBE-213). Their requester (or the replica that
 * delivered them) died before ending them, and no answer can arrive any more: they are failed and
 * Pi is told to abort, so the thread is never held by one.
 */
async function staleCompactions(
  tx: KobeTx,
  teamId: string,
  deadlineMs: number,
): Promise<StaleCompaction[]> {
  const res = await tx.execute<{ id: string; thread_id: string; owner_user_id: string }>(sql`
    SELECT r.id, r.thread_id, t.owner_user_id
      FROM runs r JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
     WHERE r.team_id = ${teamId} AND r.kind = 'compaction'
       AND r.status IN ('running', 'waiting_approval')
       AND r.started_at < now() - make_interval(secs => ${secs(deadlineMs)})`);
  return res.rows.map((r) => ({
    teamId,
    runId: r.id,
    threadId: r.thread_id,
    ownerUserId: r.owner_user_id,
  }));
}

async function pendingStops(tx: KobeTx, teamId: string, resendMs: number): Promise<PendingStop[]> {
  const res = await tx.execute<{
    id: string;
    thread_id: string;
    owner_user_id: string;
    stop_mode: "abort" | "after_step";
    budget_stop_scope: string | null;
    age_ms: string | number;
  }>(sql`
    SELECT r.id, r.thread_id, t.owner_user_id, r.stop_mode, r.budget_stop_scope,
           extract(epoch FROM now() - r.stop_requested_at) * 1000 AS age_ms
      FROM runs r JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
     WHERE r.team_id = ${teamId} AND r.stop_mode IS NOT NULL
       AND r.stop_requested_at < now() - make_interval(secs => ${secs(resendMs)})
       AND NOT EXISTS (SELECT 1 FROM sandbox_commands c
                        WHERE c.team_id = r.team_id AND c.run_id = r.id AND c.kind = 'run.stop'
                          AND c.status IN ('pending', 'delivered'))`);
  return res.rows.map((r) => ({
    teamId,
    runId: r.id,
    threadId: r.thread_id,
    ownerUserId: r.owner_user_id,
    mode: r.stop_mode,
    budgetScope: readBudgetStopScope(r.budget_stop_scope),
    ageMs: Number(r.age_ms),
  }));
}

async function stalledThreads(tx: KobeTx, teamId: string, stallMs: number) {
  const res = await tx.execute<{ thread_id: string }>(sql`
    SELECT DISTINCT q.thread_id FROM runs q
      JOIN threads t ON t.team_id = q.team_id AND t.id = q.thread_id
     WHERE q.team_id = ${teamId} AND q.status = 'queued' AND t.deleted_at IS NULL
       AND ((t.status = 'idle' AND t.queue_paused_at IS NULL) OR q.retry_of_run_id IS NOT NULL)
       AND q.created_at < now() - make_interval(secs => ${secs(stallMs)})
       AND NOT EXISTS (SELECT 1 FROM runs a
                        WHERE a.team_id = q.team_id AND a.thread_id = q.thread_id
                          AND (a.status IN ('running', 'waiting_approval')
                               OR a.ended_at > now() - make_interval(secs => ${secs(stallMs)})))
    UNION
    -- App cards still waiting with no run left to end (KOBE-440 re-review LOW-R2: they wait out
    -- Stop's abort hold, then the promotion inserts them).
    SELECT DISTINCT w.thread_id FROM thread_app_results w
      JOIN threads t ON t.team_id = w.team_id AND t.id = w.thread_id
     WHERE w.team_id = ${teamId} AND w.queued_at IS NOT NULL AND t.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM runs a
                        WHERE a.team_id = w.team_id AND a.thread_id = w.thread_id
                          AND (a.status IN ('running', 'waiting_approval')
                               OR a.ended_at > now() - make_interval(secs => ${secs(stallMs)})))`);
  return res.rows.map((r) => ({ teamId, threadId: r.thread_id }));
}

/**
 * Finds work a replica dropped (crash between commit and the next step): lost starts, unsent or
 * unanswered stops, stalled queues. Read-only; the orchestrator acts on each finding with a
 * re-check under the thread lock, so concurrent sweeps on every replica are harmless. Per team
 * (team tables are only readable inside withTeam); a failing team is logged and skipped.
 */
export async function sweepRuns(
  db: KobeDb,
  tuning: SweepTuning,
  log: Logger,
): Promise<RunSweepResult> {
  const lost: LostStart[] = [];
  const compactions: StaleCompaction[] = [];
  const stops: PendingStop[] = [];
  const stalled: { teamId: string; threadId: string }[] = [];
  let failedTeams = 0;
  const all = await db.select({ id: teams.id }).from(teams);
  for (const { id: teamId } of all) {
    try {
      await withTeam(db, teamId, async (tx) => {
        lost.push(...(await lostStarts(tx, teamId, tuning.startDeadlineMs)));
        compactions.push(...(await staleCompactions(tx, teamId, tuning.compactionDeadlineMs)));
        stops.push(...(await pendingStops(tx, teamId, tuning.stopResendMs)));
        stalled.push(...(await stalledThreads(tx, teamId, tuning.stallMs)));
      });
    } catch (err) {
      failedTeams += 1;
      log.error({ err, team_id: teamId }, "run sweep failed for a team");
    }
  }
  return {
    lostStarts: lost,
    staleCompactions: compactions,
    pendingStops: stops,
    stalledThreads: stalled,
    failedTeams,
  };
}

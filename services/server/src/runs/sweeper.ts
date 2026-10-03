import { isActiveRunStatus } from "@kobe/protocol";
import { sql, teams, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import type { Logger } from "pino";
import { withAppendTx } from "../event-stream/append.js";
import { failedEvent } from "./lifecycle.js";
import { applyTransition, lockRunRow, lockThreadRow, type AppliedTransition } from "./store.js";

export interface RunSweepResult {
  /** Runs that were `running` with no sandbox lease and no pending start (their starter died). */
  readonly failedStarts: { readonly teamId: string; readonly transition: AppliedTransition }[];
  /** Threads with queued runs and nothing active for a while (a promotion was lost). */
  readonly stalledThreads: { readonly teamId: string; readonly threadId: string }[];
  readonly failedTeams: number;
}

const secs = (ms: number) => ms / 1000;

/** No lease, and no `run.start` command still pending or delivered for the run. */
const NO_START_IN_FLIGHT = sql`
  NOT EXISTS (SELECT 1 FROM sandbox_run_leases l WHERE l.team_id = r.team_id AND l.run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM sandbox_commands c
                   WHERE c.team_id = r.team_id AND c.run_id = r.id AND c.kind = 'run.start'
                     AND c.status IN ('pending', 'delivered'))`;

async function lostStarts(tx: KobeTx, teamId: string, deadlineMs: number) {
  const res = await tx.execute<{ id: string; thread_id: string }>(sql`
    SELECT r.id, r.thread_id FROM runs r
     WHERE r.team_id = ${teamId} AND r.status = 'running'
       AND r.started_at < now() - make_interval(secs => ${secs(deadlineMs)})
       AND ${NO_START_IN_FLIGHT}`);
  return res.rows;
}

async function stalledThreads(tx: KobeTx, teamId: string, stallMs: number) {
  const res = await tx.execute<{ thread_id: string }>(sql`
    SELECT DISTINCT q.thread_id FROM runs q
      JOIN threads t ON t.team_id = q.team_id AND t.id = q.thread_id
     WHERE q.team_id = ${teamId} AND q.status = 'queued' AND t.deleted_at IS NULL
       AND (t.status = 'idle' OR q.retry_of_run_id IS NOT NULL)
       AND q.created_at < now() - make_interval(secs => ${secs(stallMs)})
       AND NOT EXISTS (SELECT 1 FROM runs a
                        WHERE a.team_id = q.team_id AND a.thread_id = q.thread_id
                          AND (a.status IN ('running', 'waiting_approval')
                               OR a.ended_at > now() - make_interval(secs => ${secs(stallMs)})))`);
  return res.rows.map((r) => r.thread_id);
}

/**
 * Recovery for work a replica dropped (crash between commit and the next step); every replica runs
 * it, and the re-checks under the thread lock make concurrent sweeps harmless. Per team (team
 * tables are only readable inside withTeam); a failing team is logged and skipped.
 */
export async function sweepRuns(
  db: KobeDb,
  tuning: { readonly startDeadlineMs: number; readonly stallMs: number },
  log: Logger,
): Promise<RunSweepResult> {
  const failedStarts: RunSweepResult["failedStarts"] = [];
  const stalled: RunSweepResult["stalledThreads"] = [];
  let failedTeams = 0;
  const all = await db.select({ id: teams.id }).from(teams);
  for (const { id: teamId } of all) {
    try {
      const found = await withTeam(db, teamId, async (tx) => ({
        lost: await lostStarts(tx, teamId, tuning.startDeadlineMs),
        stalled: await stalledThreads(tx, teamId, tuning.stallMs),
      }));
      for (const run of found.lost) {
        const transition = await withAppendTx(db, teamId, async (tx) => {
          const thread = await lockThreadRow(tx, teamId, run.thread_id);
          const row = await lockRunRow(tx, teamId, run.id);
          if (!thread || !row || !isActiveRunStatus(row.status)) return undefined;
          const still = await tx.execute(sql`
            SELECT 1 FROM runs r WHERE r.team_id = ${teamId} AND r.id = ${run.id}
               AND ${NO_START_IN_FLIGHT}`);
          if (still.rows.length === 0) return undefined;
          return (
            await applyTransition(tx, thread, row, "failed", "error", failedEvent("start_lost"))
          ).transition;
        });
        if (transition) failedStarts.push({ teamId, transition });
      }
      for (const threadId of found.stalled) stalled.push({ teamId, threadId });
    } catch (err) {
      failedTeams += 1;
      log.error({ err, team_id: teamId }, "run sweep failed for a team");
    }
  }
  if (failedStarts.length > 0) {
    log.warn({ runs: failedStarts.length }, "failed runs whose start was lost");
  }
  return { failedStarts, stalledThreads: stalled, failedTeams };
}

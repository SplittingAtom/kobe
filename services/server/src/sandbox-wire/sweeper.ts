import { sql, teams, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import type { Logger } from "pino";
import { withAppendTx } from "../event-stream/append.js";
import type { SandboxBus } from "./bus.js";
import type { WireTuning } from "./constants.js";
import { endRunInTx } from "./run-state.js";

/** Completed command rows are kept this long for a requester that polls late, then deleted. */
const RESULT_RETENTION_SECONDS = 600;

export interface SweepResult {
  readonly interrupted: { teamId: string; runId: string; threadId: string }[];
  readonly expired: number;
  /** Teams whose sweep failed (logged); the others were still swept. */
  readonly failedTeams: number;
}

const secs = (ms: number) => ms / 1000;

/**
 * "This sandbox has no live connection": none at all, closed for longer than the grace period (a
 * reconnect within it resumes the run), or still open but not touched for `staleConnectionMs`
 * (its replica died with the socket).
 */
function goneSql(tuning: WireTuning) {
  return sql`(c.user_id IS NULL
      OR (c.closed_at IS NOT NULL
          AND c.closed_at < now() - make_interval(secs => ${secs(tuning.lostGraceMs)}))
      OR (c.closed_at IS NULL
          AND c.last_seen_at < now() - make_interval(secs => ${secs(tuning.staleConnectionMs)})))`;
}

async function lostRuns(
  tx: KobeTx,
  teamId: string,
  tuning: WireTuning,
): Promise<{ runId: string; userId: string }[]> {
  const res = await tx.execute<{ run_id: string; user_id: string }>(sql`
    SELECT l.run_id, l.user_id
      FROM sandbox_run_leases l
      JOIN runs r ON r.team_id = l.team_id AND r.id = l.run_id
      LEFT JOIN sandbox_connections c ON c.team_id = l.team_id AND c.user_id = l.user_id
     WHERE l.team_id = ${teamId}
       AND r.status IN ('running', 'waiting_approval')
       AND l.leased_at < now() - make_interval(secs => ${secs(tuning.lostGraceMs)})
       AND ${goneSql(tuning)}`);
  return res.rows.map((r) => ({ runId: r.run_id, userId: r.user_id }));
}

/**
 * Ends one lost run, re-checking inside the same transaction that its sandbox is still gone: the
 * connection row is locked first, so a `hello` that resumes the run (it registers by updating that
 * row) either commits before this check — the run is kept — or waits until the run is ended, and
 * then does not list it.
 */
async function interruptIfStillGone(
  db: KobeDb,
  teamId: string,
  run: { runId: string; userId: string },
  tuning: WireTuning,
): Promise<{ ended: boolean; threadId?: string }> {
  return withAppendTx(db, teamId, async (tx) => {
    await tx.execute(sql`
      SELECT 1 FROM sandbox_connections
       WHERE team_id = ${teamId} AND user_id = ${run.userId} FOR UPDATE`);
    const still = await tx.execute(sql`
      SELECT 1 FROM sandbox_run_leases l
        LEFT JOIN sandbox_connections c ON c.team_id = l.team_id AND c.user_id = l.user_id
       WHERE l.team_id = ${teamId} AND l.run_id = ${run.runId} AND ${goneSql(tuning)}`);
    if (still.rowCount !== 1) return { ended: false };
    return endRunInTx(tx, teamId, run.runId, { status: "interrupted" }, "sandbox_gone");
  });
}

async function expireCommands(tx: KobeTx, bus: SandboxBus, teamId: string): Promise<number> {
  // Commands past their deadline: failed for their requester, then forgotten.
  const timedOut = await tx.execute<{ id: string }>(sql`
    UPDATE sandbox_commands
       SET status = 'failed', completed_at = now(),
           result = '{"ok":false,"error":{"code":"timeout","message":"the sandbox did not answer in time"}}'::jsonb
     WHERE team_id = ${teamId} AND status IN ('pending', 'delivered') AND expires_at < now()
    RETURNING id`);
  for (const row of timedOut.rows) await bus.notifyInTx(tx, { kind: "res", id: row.id });
  await tx.execute(sql`
    DELETE FROM sandbox_commands
     WHERE team_id = ${teamId} AND status IN ('done', 'failed')
       AND completed_at < now() - make_interval(secs => ${RESULT_RETENTION_SECONDS})`);
  return timedOut.rows.length;
}

/**
 * Lost-sandbox sweep (D14) and command expiry, per team (team tables are only readable inside
 * withTeam). Idempotent: every replica runs it and guarded updates make concurrent sweeps harmless.
 * A failing team is logged and skipped, never blocks the others.
 */
export async function sweepOnce(
  db: KobeDb,
  bus: SandboxBus,
  tuning: WireTuning,
  log: Logger,
): Promise<SweepResult> {
  const interrupted: SweepResult["interrupted"] = [];
  let expired = 0;
  let failedTeams = 0;
  const all = await db.select({ id: teams.id }).from(teams);
  for (const { id: teamId } of all) {
    try {
      const lost = await withTeam(db, teamId, async (tx) => {
        expired += await expireCommands(tx, bus, teamId);
        return lostRuns(tx, teamId, tuning);
      });
      for (const run of lost) {
        const { ended, threadId } = await interruptIfStillGone(db, teamId, run, tuning);
        if (ended && threadId) interrupted.push({ teamId, runId: run.runId, threadId });
      }
    } catch (err) {
      failedTeams += 1;
      log.error({ err, team_id: teamId }, "sandbox sweep failed for a team");
    }
  }
  return { interrupted, expired, failedTeams };
}

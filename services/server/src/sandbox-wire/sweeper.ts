import { sql, teams, withTeam, type KobeDb } from "@kobe/db";
import { withAppendTx } from "../event-stream/append.js";
import type { SandboxBus } from "./bus.js";
import type { WireTuning } from "./constants.js";
import { endRunInTx } from "./run-state.js";

/** Completed command rows are kept this long for a requester that polls late, then deleted. */
const RESULT_RETENTION_SECONDS = 600;

export interface SweepResult {
  readonly interrupted: { teamId: string; runId: string; threadId: string }[];
  readonly expired: number;
}

const secs = (ms: number) => ms / 1000;

/**
 * Lost-sandbox sweep (D14) and command expiry, per team (team tables are only readable inside
 * withTeam). Idempotent: every replica runs it; guarded updates make concurrent sweeps harmless.
 *
 * A run is lost when it is active, leased to a sandbox, and that sandbox has no live connection:
 * none at all, closed for longer than the grace period (a reconnect within it resumes the run), or
 * still marked open but not touched for `staleConnectionMs` (its replica died with the socket).
 */
export async function sweepOnce(
  db: KobeDb,
  bus: SandboxBus,
  tuning: WireTuning,
): Promise<SweepResult> {
  const interrupted: SweepResult["interrupted"] = [];
  let expired = 0;
  const all = await db.select({ id: teams.id }).from(teams);
  for (const { id: teamId } of all) {
    const lost = await withTeam(db, teamId, async (tx) => {
      const res = await tx.execute<{ run_id: string }>(sql`
        SELECT l.run_id
          FROM sandbox_run_leases l
          JOIN runs r ON r.team_id = l.team_id AND r.id = l.run_id
          LEFT JOIN sandbox_connections c ON c.team_id = l.team_id AND c.user_id = l.user_id
         WHERE l.team_id = ${teamId}
           AND r.status IN ('running', 'waiting_approval')
           AND l.leased_at < now() - make_interval(secs => ${secs(tuning.lostGraceMs)})
           AND (c.user_id IS NULL
                OR (c.closed_at IS NOT NULL
                    AND c.closed_at < now() - make_interval(secs => ${secs(tuning.lostGraceMs)}))
                OR (c.closed_at IS NULL
                    AND c.last_seen_at < now() - make_interval(secs => ${secs(tuning.staleConnectionMs)})))`);
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
      expired += timedOut.rows.length;
      return res.rows.map((r) => r.run_id);
    });
    for (const runId of lost) {
      const { ended, threadId } = await withAppendTx(db, teamId, (tx) =>
        endRunInTx(tx, teamId, runId, { status: "interrupted" }, "sandbox_gone"),
      );
      if (ended && threadId) interrupted.push({ teamId, runId, threadId });
    }
  }
  return { interrupted, expired };
}

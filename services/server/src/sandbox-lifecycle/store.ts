import { sql, withTeam, type KobeDb, type KobeTx, type SandboxState } from "@kobe/db";
import type { SandboxTarget } from "../sandbox-wire/types.js";
import { TEAM_IDLE_MINUTES } from "./idle.js";

/**
 * The `sandboxes` rows (KOBE-25): Kobe's record of awake vs hibernated and of the last activity.
 * Every write that decides a sandbox's state, or proves it active, takes the row's lock, so a
 * hibernation decision (made and carried out under the lock) and a wake or command touch (which
 * update the row first) are ordered across replicas. Team table: every statement runs inside
 * `withTeam` and names the team explicitly.
 */

/**
 * Wake decision: the row becomes `running` with fresh activity, under its lock. Returns the state
 * it had (undefined: no row yet). A `destroyed` (offboarded) sandbox is left alone: the caller
 * refuses to wake it.
 */
export async function beginWake(
  db: KobeDb,
  target: SandboxTarget,
): Promise<SandboxState | undefined> {
  return withTeam(db, target.teamId, async (tx) => {
    const prev = await tx.execute<{ state: SandboxState }>(sql`
      SELECT state FROM sandboxes
       WHERE team_id = ${target.teamId} AND user_id = ${target.userId} FOR UPDATE`);
    const state = prev.rows[0]?.state;
    if (state === "destroyed") return state;
    await tx.execute(sql`
      INSERT INTO sandboxes (team_id, user_id, state, last_active_at, state_changed_at)
      VALUES (${target.teamId}, ${target.userId}, 'running', now(), now())
      ON CONFLICT (team_id, user_id) DO UPDATE
        SET last_active_at = now(),
            state = 'running',
            state_changed_at = CASE WHEN sandboxes.state = 'running'
                                    THEN sandboxes.state_changed_at ELSE now() END`);
    return state;
  });
}

/** After a wake: which claim (sandbox id) and volume the row describes. */
export async function recordSandboxIdentity(
  tx: KobeTx,
  target: SandboxTarget,
  sandboxId: string,
  pvc: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE sandboxes SET sandbox_id = ${sandboxId}, pvc = ${pvc}
     WHERE team_id = ${target.teamId} AND user_id = ${target.userId}`);
}

export interface IdleCandidate {
  readonly userId: string;
  readonly idleMinutes: number;
}

/**
 * Awake sandboxes of a team whose last recorded activity is older than the team's idle time
 * (unlocked read; each candidate is re-checked under its row lock by {@link lockIfIdle}).
 */
export async function idleCandidates(
  tx: KobeTx,
  teamId: string,
  idleMinutes: number,
  limit: number,
): Promise<IdleCandidate[]> {
  const res = await tx.execute<{ user_id: string }>(sql`
    SELECT user_id FROM sandboxes
     WHERE team_id = ${teamId} AND state = 'running'
       AND last_active_at < now() - make_interval(mins => ${idleMinutes})
     ORDER BY last_active_at
     LIMIT ${limit}`);
  return res.rows.map((r) => ({ userId: r.user_id, idleMinutes }));
}

/** A team's `teams.settings` idle-minutes value (raw; validated by `resolveIdleMinutes`). */
export async function teamIdleSetting(db: KobeDb, teamId: string): Promise<unknown> {
  const res = await db.execute<{ v: unknown }>(sql`
    SELECT settings -> ${TEAM_IDLE_MINUTES} AS v FROM teams WHERE id = ${teamId}`);
  return res.rows[0]?.v ?? undefined;
}

export interface LockedSandbox {
  readonly sandboxId: string | null;
}

/**
 * Locks the row and re-checks, inside the hibernating transaction, that the sandbox may hibernate
 * (D14): still `running`; idle for `idleMinutes` (last activity = the row's, or the end of the
 * user's latest run in the team, whichever is later; `force` skips this for operators and the
 * cold-start harness); no queued, running or approval-waiting run on the user's threads in the
 * team; no command waiting for or delivered to the sandbox. Undefined when it may not, or when
 * another replica holds the row (SKIP LOCKED: it is deciding or waking right now).
 */
export async function lockIfIdle(
  tx: KobeTx,
  target: SandboxTarget,
  idleMinutes: number,
  force: boolean,
): Promise<LockedSandbox | undefined> {
  const res = await tx.execute<{
    sandbox_id: string | null;
    idle: boolean;
    busy: boolean;
    commands: boolean;
  }>(sql`
    SELECT s.sandbox_id,
           GREATEST(s.last_active_at, (
             SELECT max(r.ended_at) FROM runs r
               JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
              WHERE r.team_id = ${target.teamId} AND t.team_id = ${target.teamId}
                AND t.owner_user_id = ${target.userId}
           )) < now() - make_interval(mins => ${idleMinutes}) AS idle,
           EXISTS (
             SELECT 1 FROM runs r
               JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
              WHERE r.team_id = ${target.teamId} AND t.team_id = ${target.teamId}
                AND t.owner_user_id = ${target.userId}
                AND r.status IN ('queued', 'running', 'waiting_approval')
           ) AS busy,
           EXISTS (
             SELECT 1 FROM sandbox_commands c
              WHERE c.team_id = ${target.teamId} AND c.user_id = ${target.userId}
                AND c.status IN ('pending', 'delivered')
           ) AS commands
      FROM sandboxes s
     WHERE s.team_id = ${target.teamId} AND s.user_id = ${target.userId} AND s.state = 'running'
     FOR UPDATE OF s SKIP LOCKED`);
  const row = res.rows[0];
  if (!row || row.busy || row.commands || !(force || row.idle)) return undefined;
  return { sandboxId: row.sandbox_id };
}

/**
 * Records the hibernation (inside the transaction that holds the lock) and closes the sandbox's
 * connection row, so nothing is routed to a pod on its way out. Returns the connection to close.
 */
export async function markHibernated(
  tx: KobeTx,
  target: SandboxTarget,
): Promise<string | undefined> {
  await tx.execute(sql`
    UPDATE sandboxes SET state = 'hibernated', state_changed_at = now()
     WHERE team_id = ${target.teamId} AND user_id = ${target.userId}`);
  const closed = await tx.execute<{ connection_id: string }>(sql`
    UPDATE sandbox_connections SET closed_at = now()
     WHERE team_id = ${target.teamId} AND user_id = ${target.userId} AND closed_at IS NULL
    RETURNING connection_id`);
  return closed.rows[0]?.connection_id;
}

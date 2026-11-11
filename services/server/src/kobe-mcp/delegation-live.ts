import { sql, withTeam, type KobeDb } from "@kobe/db";
import type { Delegation } from "./delegation.js";

/**
 * Whether a delegation is still backed by the person's own sign-in (KOBE-619 review M1): its run
 * is active, in its thread, owned by the person, and a session of the person that was already live
 * when the run started is live now. Signing out everywhere (or a deactivation, a password reset)
 * deletes those rows, so the run's admin tools stop at the next call; a sign-in after the run
 * started does not revive them. Without recording the session on the run (which needs a
 * migration), a run started from one device keeps working while another older session of the same
 * person is still live.
 */
export async function delegationBacked(db: KobeDb, d: Delegation): Promise<boolean> {
  return withTeam(db, d.teamId, async (tx) => {
    const res = await tx.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM public.sessions s
         WHERE s.user_id = ${d.userId} AND s.expires_at > now()
           AND s.created_at <= r.created_at) AS ok
        FROM runs r
        JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
       WHERE r.team_id = ${d.teamId} AND t.team_id = ${d.teamId}
         AND r.id = ${d.runId} AND t.id = ${d.threadId}
         AND t.owner_user_id = ${d.userId}
         AND r.status IN ('running', 'waiting_approval')`);
    return res.rows[0]?.ok === true;
  });
}

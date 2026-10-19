import { sql, withTeam } from "@kobe/db";
import { logger } from "../logger.js";
import { notifyEval } from "../skills/evals/store.js";
import type { OffboardingContext, TeamIdentity } from "./types.js";

/**
 * A departing member's skill evals (KOBE-325): their open eval runs are cancelled (nothing more
 * starts; done executions stay as partial results), their live eval sandboxes deleted and those
 * sandboxes' connections closed. The reaper deletes any claim this misses.
 */
export async function offboardSkillEvals(
  ctx: OffboardingContext,
  team: TeamIdentity,
  userId: string,
): Promise<{ cancelled: number; sandboxes: number }> {
  const { cancelled, threads } = await withTeam(ctx.db, team.id, async (tx) => {
    const runs = await tx.execute<{ id: string }>(sql`
      UPDATE skill_eval_runs
         SET status = 'cancelled', cancel_requested_at = now(), finished_at = now(),
             updated_at = now()
       WHERE team_id = ${team.id} AND started_by = ${userId} AND status IN ('queued', 'running')
      RETURNING id`);
    for (const r of runs.rows) await notifyEval(tx, team.id, r.id);
    const live = await tx.execute<{ thread_id: string }>(sql`
      SELECT c.thread_id FROM sandbox_eval_connections c
       WHERE c.team_id = ${team.id} AND c.user_id = ${userId}
      UNION
      SELECT x.thread_id FROM skill_eval_results x
        JOIN skill_eval_runs r ON r.team_id = x.team_id AND r.id = x.eval_run_id
       WHERE x.team_id = ${team.id} AND r.started_by = ${userId} AND x.thread_id IS NOT NULL
         AND x.state IN ('starting', 'running', 'collecting')`);
    await tx.execute(sql`
      UPDATE sandbox_eval_connections SET closed_at = now()
       WHERE team_id = ${team.id} AND user_id = ${userId} AND closed_at IS NULL`);
    return { cancelled: runs.rows.length, threads: live.rows.map((r) => r.thread_id) };
  });
  const provider = ctx.provider();
  let sandboxes = 0;
  for (const threadId of threads) {
    try {
      if (await provider?.deleteEvalSandbox(team, threadId)) sandboxes += 1;
    } catch (err) {
      logger.warn({ err, team_id: team.id, thread_id: threadId }, "eval sandbox delete failed");
    }
  }
  return { cancelled, sandboxes };
}

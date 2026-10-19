import { sql, teams, withTeam, type KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import type { ServerRunOrchestrator } from "../../runs/orchestrator.js";
import type { SandboxProvider } from "../../sandbox/provider.js";
import { requeueExecution } from "./store.js";

// The skill eval reaper (KOBE-325): the cleanup path for a server that died mid-execution (or a
// delete that failed). One replica at a time (an advisory lock, `SKILL_EVAL_REAPER_LOCK`). It
// (1) takes over executions whose heartbeat stopped (their replica died; a live runner beats every
// 15 s, deadline or not, so a slow snapshot is never cut short): the run is stopped, the sandbox
// deleted and the execution goes back to queued without using its attempt (an infrastructure
// event, never the skill's result); and (2) deletes every eval sandbox claim (by label, in every
// team namespace) whose execution no longer runs: done, gone, cancelled or without a heartbeat.
// The claim's own shutdownTime is the cluster-side backstop. It needs the sandbox provider, so it
// stays in index.ts beside the Orbit sweep (main's `startup/jobs.ts` keeps such jobs there).

export const SKILL_EVAL_REAPER_LOCK = "kobe.skill-eval.reaper";
export const SKILL_EVAL_REAPER_MS = 30_000;
/** An execution without a heartbeat for this long has no live runner. */
export const SKILL_EVAL_HEARTBEAT_TIMEOUT_MS = 60_000;

export interface SkillEvalReaperDeps {
  readonly db: KobeDb;
  readonly provider: Pick<SandboxProvider, "listEvalSandboxes" | "deleteEvalSandbox">;
  readonly runs: Pick<ServerRunOrchestrator, "cancel">;
  readonly log: Pick<Logger, "warn" | "info">;
  readonly heartbeatTimeoutMs?: number;
}

export interface ReapResult {
  readonly executions: number;
  readonly claims: number;
}

type OrphanRow = {
  eval_run_id: string;
  case_id: string;
  with_skill: boolean;
  thread_id: string;
  run_id: string | null;
  started_by: string;
};

async function takeOverOrphans(
  deps: SkillEvalReaperDeps,
  team: { id: string; slug: string },
): Promise<number> {
  const timeout = (deps.heartbeatTimeoutMs ?? SKILL_EVAL_HEARTBEAT_TIMEOUT_MS) / 1000;
  const orphans = await withTeam(deps.db, team.id, (tx) =>
    tx.execute<OrphanRow>(sql`
      SELECT x.eval_run_id, x.case_id, x.with_skill, x.thread_id, x.run_id, r.started_by
        FROM skill_eval_results x
        JOIN skill_eval_runs r ON r.team_id = x.team_id AND r.id = x.eval_run_id
       WHERE x.team_id = ${team.id} AND x.state IN ('starting', 'running', 'collecting')
         AND x.thread_id IS NOT NULL
         AND x.updated_at < now() - make_interval(secs => ${timeout})`),
  );
  let taken = 0;
  for (const row of orphans.rows) {
    if (row.run_id) {
      const actor = {
        user_id: row.started_by,
        team_id: team.id,
        site_role: "user" as const,
        team_role: "member" as const,
      };
      await deps.runs.cancel(actor, row.run_id).catch(() => undefined);
    }
    await deps.provider.deleteEvalSandbox(team, row.thread_id).catch(() => false);
    const requeued = await requeueExecution(deps.db, {
      teamId: team.id,
      evalRunId: row.eval_run_id,
      caseId: row.case_id,
      withSkill: row.with_skill,
      threadId: row.thread_id,
    });
    if (requeued) taken += 1;
  }
  return taken;
}

/** One reaper pass over every team and every eval sandbox claim. */
export async function reapSkillEvals(deps: SkillEvalReaperDeps): Promise<ReapResult> {
  const all = await deps.db.select({ id: teams.id, slug: teams.slug }).from(teams);
  let executions = 0;
  for (const team of all) {
    try {
      executions += await takeOverOrphans(deps, team);
    } catch (err) {
      deps.log.warn({ err, team_id: team.id }, "skill eval reaper: a team failed");
    }
  }
  const timeout = (deps.heartbeatTimeoutMs ?? SKILL_EVAL_HEARTBEAT_TIMEOUT_MS) / 1000;
  const teamsById = new Map(all.map((t) => [t.id, t]));
  let claims = 0;
  for (const claim of await deps.provider.listEvalSandboxes()) {
    const team = teamsById.get(claim.teamId);
    const running = team
      ? await withTeam(deps.db, team.id, async (tx) => {
          const res = await tx.execute(sql`
            SELECT 1 FROM skill_eval_results x
              JOIN skill_eval_runs r ON r.team_id = x.team_id AND r.id = x.eval_run_id
             WHERE x.team_id = ${team.id} AND x.thread_id = ${claim.threadId}
               AND x.state IN ('starting', 'running', 'collecting')
               AND x.updated_at > now() - make_interval(secs => ${timeout})
               AND r.status IN ('queued', 'running')`);
          return res.rows.length > 0;
        })
      : false;
    if (running || !team) continue;
    if (await deps.provider.deleteEvalSandbox(team, claim.threadId).catch(() => false)) claims += 1;
  }
  if (executions + claims > 0)
    deps.log.info({ executions, claims }, "skill eval reaper cleaned up");
  return { executions, claims };
}

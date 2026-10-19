import { sql, teams, withTeam, type KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import type { ServerRunOrchestrator } from "../../runs/orchestrator.js";
import type { SandboxProvider } from "../../sandbox/provider.js";
import { errorAttempt, type EvalAttempt } from "./execution.js";
import { recordAttempt } from "./store.js";

// The skill eval reaper (KOBE-325): the cleanup path for a server that died mid-execution (or a
// delete that failed). One replica at a time (an advisory lock, `SKILL_EVAL_REAPER_LOCK`). It
// (1) ends executions past their wall clock plus a grace (their replica would have ended them):
// the run is stopped and the attempt recorded as an error, so the retry or the score follows as
// usual; executions of a cancelled eval go back to queued; and (2) deletes every eval sandbox
// claim (by label, in every team namespace) whose execution is no longer running: done, gone,
// cancelled or past its deadline. The claim's own shutdownTime is the cluster-side backstop.
// Startup-job note: this is a lock-guarded periodic job; with main's G5 `startup/jobs.ts` it
// slots in there once this branch merges (it needs the sandbox provider, as the Orbit sweep).

export const SKILL_EVAL_REAPER_LOCK = "kobe.skill-eval.reaper";
export const SKILL_EVAL_REAPER_MS = 60_000;
/** How long past its deadline an execution's own replica has to end it. */
export const SKILL_EVAL_DEADLINE_GRACE_MS = 2 * 60_000;

export interface SkillEvalReaperDeps {
  readonly db: KobeDb;
  readonly provider: Pick<SandboxProvider, "listEvalSandboxes" | "deleteEvalSandbox">;
  readonly runs: Pick<ServerRunOrchestrator, "cancel">;
  readonly log: Pick<Logger, "warn" | "info">;
  readonly graceMs?: number;
}

export interface ReapResult {
  readonly executions: number;
  readonly claims: number;
}

type LateRow = {
  eval_run_id: string;
  case_id: string;
  with_skill: boolean;
  attempt: number;
  first_attempt: EvalAttempt | null;
  thread_id: string;
  run_id: string | null;
  started_by: string;
  used: string;
  started_at: Date | string | null;
};

async function endLateExecutions(deps: SkillEvalReaperDeps, team: { id: string; slug: string }) {
  const grace = (deps.graceMs ?? SKILL_EVAL_DEADLINE_GRACE_MS) / 1000;
  const late = await withTeam(deps.db, team.id, (tx) =>
    tx.execute<LateRow>(sql`
      SELECT x.eval_run_id, x.case_id, x.with_skill, x.attempt, x.first_attempt, x.thread_id,
             x.run_id, r.started_by, r.run_model ->> 'used' AS used, x.started_at
        FROM skill_eval_results x
        JOIN skill_eval_runs r ON r.team_id = x.team_id AND r.id = x.eval_run_id
       WHERE x.team_id = ${team.id} AND x.state IN ('starting', 'running', 'collecting')
         AND x.thread_id IS NOT NULL
         AND (x.deadline_at < now() - make_interval(secs => ${grace})
              OR (r.status NOT IN ('queued', 'running')
                  AND x.updated_at < now() - make_interval(secs => ${grace})))`),
  );
  let ended = 0;
  for (const row of late.rows) {
    if (row.run_id) {
      const actor = {
        user_id: row.started_by,
        team_id: team.id,
        site_role: "user" as const,
        team_role: "member" as const,
      };
      await deps.runs.cancel(actor, row.run_id).catch(() => undefined);
    }
    const since = row.started_at ? Date.now() - new Date(row.started_at).getTime() : 0;
    const outcome = await recordAttempt(
      deps.db,
      {
        teamId: team.id,
        evalRunId: row.eval_run_id,
        caseId: row.case_id,
        withSkill: row.with_skill,
        threadId: row.thread_id,
        attempt: row.attempt === 2 ? 2 : 1,
        firstAttempt: row.first_attempt,
      },
      errorAttempt(row.thread_id, row.run_id, Math.max(0, since)),
      row.used,
    );
    await deps.provider.deleteEvalSandbox(team, row.thread_id).catch(() => false);
    if (outcome !== "stale") ended += 1;
  }
  return ended;
}

/** One reaper pass over every team and every eval sandbox claim. */
export async function reapSkillEvals(deps: SkillEvalReaperDeps): Promise<ReapResult> {
  const all = await deps.db.select({ id: teams.id, slug: teams.slug }).from(teams);
  let executions = 0;
  for (const team of all) {
    try {
      executions += await endLateExecutions(deps, team);
    } catch (err) {
      deps.log.warn({ err, team_id: team.id }, "skill eval reaper: a team failed");
    }
  }
  const bySlug = new Map(all.map((t) => [t.id, t]));
  let claims = 0;
  for (const claim of await deps.provider.listEvalSandboxes()) {
    const team = bySlug.get(claim.teamId);
    const running = team
      ? await withTeam(deps.db, team.id, async (tx) => {
          const res = await tx.execute(sql`
            SELECT 1 FROM skill_eval_results x
              JOIN skill_eval_runs r ON r.team_id = x.team_id AND r.id = x.eval_run_id
             WHERE x.team_id = ${team.id} AND x.thread_id = ${claim.threadId}
               AND x.state IN ('starting', 'running', 'collecting')
               AND x.deadline_at > now() - interval '1 minute'
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

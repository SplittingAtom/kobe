import { sql, type KobeTx } from "@kobe/db";
import {
  skillEvalEstimateSchema,
  type SkillEvalEstimate,
  type SkillEvalPlannedExecution,
  type SkillEvalSuite,
} from "@kobe/protocol";
import { gatewayModelOf } from "../../runs/models.js";

// The eval estimate (KOBE-327, SK18; contract KOBE-324 `skillEvalEstimateSchema`): "≈ $X, ≈ N
// min" before Run, from the plan's executions × the team's recent per-model averages.
//
// - **Per execution:** the mean total cost and duration (retries included) of the team's eval
//   executions on the run model in the last 30 days (up to the newest 200); a case with a
//   rubric adds the mean judge cost of the judged ones. Without eval history on that model, the
//   team's ordinary runs on it stand in (cost and duration per run), and the judge's mean call
//   cost from the team's `eval_judge` rows. No history at all: `basis: none`, null numbers.
// - **Minutes:** the executions run `concurrency` at a time, so ⌈executions / concurrency⌉ ×
//   the mean duration.
// - Model calls without catalog prices cost nothing in dollars: the cost is then null.
//
// ac-2's ±50 % on the reference suite: `skill-eval-estimate.db.test.ts` (recorded reference
// usage) and the check on gate1 described in docs/ledger/KOBE-327.md.

export const ESTIMATE_HISTORY_DAYS = 30;
export const ESTIMATE_HISTORY_LIMIT = 200;

interface Means {
  /** Per execution (or run): null when unpriced. */
  readonly costUsd: number | null;
  readonly durationMs: number;
  readonly samples: number;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** The team's eval executions on `alias`: mean cost, duration, and judge cost per judged one. */
async function evalHistory(tx: KobeTx, teamId: string, alias: string) {
  const res = await tx.execute<Row>(sql`
    SELECT count(*) AS n, avg(cost) AS cost, avg(ms) AS ms,
           avg(judge) FILTER (WHERE judge > 0) AS judge
      FROM (SELECT (x.execution ->> 'totalCostUsd')::numeric AS cost,
                   (x.execution ->> 'judgeCostUsd')::numeric AS judge,
                   (x.execution ->> 'totalDurationMs')::numeric AS ms
              FROM skill_eval_results x
              JOIN skill_eval_runs r ON r.team_id = x.team_id AND r.id = x.eval_run_id
             WHERE x.team_id = ${teamId} AND x.state = 'done'
               AND r.run_model ->> 'used' = ${alias}
               AND x.execution ->> 'status' <> 'error'
               AND x.finished_at > now() - make_interval(days => ${ESTIMATE_HISTORY_DAYS})
             ORDER BY x.finished_at DESC LIMIT ${ESTIMATE_HISTORY_LIMIT}) h`);
  const r = res.rows[0] ?? {};
  const n = Number(r.n ?? 0);
  return {
    means: n > 0 ? { costUsd: num(r.cost), durationMs: Number(r.ms ?? 0), samples: n } : null,
    judgeUsd: num(r.judge),
  };
}

/** The team's ordinary runs on the model: mean cost and duration per run (the stand-in). */
async function runHistory(tx: KobeTx, teamId: string, model: string): Promise<Means | null> {
  const res = await tx.execute<Row>(sql`
    SELECT count(*) AS n, avg(c.cost) AS cost,
           avg(extract(epoch FROM (r.ended_at - r.started_at)) * 1000) AS ms
      FROM (SELECT u.run_id, sum(u.cost_usd) AS cost, max(u.at) AS last
              FROM run_usage u
             WHERE u.team_id = ${teamId} AND u.kind = 'run' AND u.model = ${model}
               AND u.run_id IS NOT NULL
               AND u.at > now() - make_interval(days => ${ESTIMATE_HISTORY_DAYS})
             GROUP BY u.run_id ORDER BY last DESC LIMIT ${ESTIMATE_HISTORY_LIMIT}) c
      JOIN runs r ON r.team_id = ${teamId} AND r.id = c.run_id
     WHERE r.status = 'completed' AND r.started_at IS NOT NULL AND r.ended_at IS NOT NULL`);
  const r = res.rows[0] ?? {};
  const n = Number(r.n ?? 0);
  return n > 0 ? { costUsd: num(r.cost), durationMs: Number(r.ms ?? 0), samples: n } : null;
}

/** The mean cost of the team's eval judge calls (any model), for a stand-in estimate. */
async function judgeCallMean(tx: KobeTx, teamId: string): Promise<number | null> {
  const res = await tx.execute<Row>(sql`
    SELECT avg(cost_usd) AS cost FROM (
      SELECT cost_usd FROM run_usage
       WHERE team_id = ${teamId} AND kind = 'eval_judge'
         AND at > now() - make_interval(days => ${ESTIMATE_HISTORY_DAYS})
       ORDER BY at DESC LIMIT ${ESTIMATE_HISTORY_LIMIT}) j`);
  return num(res.rows[0]?.cost);
}

const roundUsd = (x: number) => Math.round(x * 10_000) / 10_000;

/** The estimate of running `plan` on the run model `alias` (inside the team's transaction). */
export async function estimateSkillEvalIn(
  tx: KobeTx,
  input: {
    readonly teamId: string;
    readonly runModel: string;
    readonly suite: SkillEvalSuite;
    readonly plan: readonly SkillEvalPlannedExecution[];
    readonly concurrency: number;
  },
): Promise<SkillEvalEstimate> {
  const executions = input.plan.length;
  const history = await evalHistory(tx, input.teamId, input.runModel);
  let means = history.means;
  let judgeUsd = history.judgeUsd;
  if (!means) {
    const model = await gatewayModelOf(tx, input.runModel);
    means = model ? await runHistory(tx, input.teamId, model) : null;
  }
  if (!means) return { executions, costUsd: null, minutes: null, basis: "none" };
  judgeUsd ??= await judgeCallMean(tx, input.teamId);
  const judged = new Set(input.suite.cases.filter((c) => c.expect.judge).map((c) => c.id));
  const judgedRuns = input.plan.filter((e) => judged.has(e.caseId)).length;
  const costUsd =
    means.costUsd === null
      ? null
      : roundUsd(means.costUsd * executions + (judgeUsd ?? 0) * judgedRuns);
  const waves = Math.ceil(executions / Math.max(1, input.concurrency));
  const minutes = Math.max(1, Math.ceil((waves * means.durationMs) / 60_000));
  return skillEvalEstimateSchema.parse({ executions, costUsd, minutes, basis: "team_history" });
}

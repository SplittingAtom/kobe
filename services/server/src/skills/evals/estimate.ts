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
// - **Whose history** (review-327 R1): Team admins (`team.budgets.manage`, who see team usage
//   anyway) get the team's means (`team_history`); everyone else only their own runs and evals
//   (`own_history`), so no estimate ever carries another member's usage. Without any history of
//   the caller's: the suite's own sizes (`suite_size`): per execution ESTIMATE_TURNS model turns of
//   the base context, the case prompt and its fixtures (4 bytes a token), with ESTIMATE_OUTPUT
//   tokens out each, plus a judge call per judged execution, at the run model's catalog prices;
//   ESTIMATE_MINUTES per wave. No model or prices: the cost is null.
//
// ac-2's ±50 % on the reference suite: `skill-eval-estimate.db.test.ts` (recorded reference
// usage) and the check on gate1 described in docs/ledger/KOBE-327.md.

export const ESTIMATE_HISTORY_DAYS = 30;
export const ESTIMATE_HISTORY_LIMIT = 200;
/** The suite-size fallback's assumptions (no history of the caller's on the model). */
export const ESTIMATE_TURNS = 3;
export const ESTIMATE_BASE_INPUT_TOKENS = 8_000;
export const ESTIMATE_OUTPUT_TOKENS = 800;
export const ESTIMATE_JUDGE_TOKENS = { input: 6_000, output: 300 } as const;
export const ESTIMATE_MINUTES = 2;

interface Means {
  /** Per execution (or run): null when unpriced. */
  readonly costUsd: number | null;
  readonly durationMs: number;
  readonly samples: number;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** The team's eval executions on `alias`: mean cost, duration, and judge cost per judged one. */
async function evalHistory(tx: KobeTx, teamId: string, alias: string, only: string | null) {
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
               AND (${only}::uuid IS NULL OR r.started_by = ${only}::uuid)
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
async function runHistory(
  tx: KobeTx,
  teamId: string,
  model: string,
  only: string | null,
): Promise<Means | null> {
  const res = await tx.execute<Row>(sql`
    SELECT count(*) AS n, avg(c.cost) AS cost,
           avg(extract(epoch FROM (r.ended_at - r.started_at)) * 1000) AS ms
      FROM (SELECT u.run_id, sum(u.cost_usd) AS cost, max(u.at) AS last
              FROM run_usage u
             WHERE u.team_id = ${teamId} AND u.kind = 'run' AND u.model = ${model}
               AND u.run_id IS NOT NULL
               AND (${only}::uuid IS NULL OR u.user_id = ${only}::uuid)
               AND u.at > now() - make_interval(days => ${ESTIMATE_HISTORY_DAYS})
             GROUP BY u.run_id ORDER BY last DESC LIMIT ${ESTIMATE_HISTORY_LIMIT}) c
      JOIN runs r ON r.team_id = ${teamId} AND r.id = c.run_id
     WHERE r.status = 'completed' AND r.started_at IS NOT NULL AND r.ended_at IS NOT NULL`);
  const r = res.rows[0] ?? {};
  const n = Number(r.n ?? 0);
  return n > 0 ? { costUsd: num(r.cost), durationMs: Number(r.ms ?? 0), samples: n } : null;
}

/** The mean cost of the team's eval judge calls (any model), for a stand-in estimate. */
async function judgeCallMean(
  tx: KobeTx,
  teamId: string,
  only: string | null,
): Promise<number | null> {
  const res = await tx.execute<Row>(sql`
    SELECT avg(cost_usd) AS cost FROM (
      SELECT cost_usd FROM run_usage
       WHERE team_id = ${teamId} AND kind = 'eval_judge'
         AND (${only}::uuid IS NULL OR user_id = ${only}::uuid)
         AND at > now() - make_interval(days => ${ESTIMATE_HISTORY_DAYS})
       ORDER BY at DESC LIMIT ${ESTIMATE_HISTORY_LIMIT}) j`);
  return num(res.rows[0]?.cost);
}

const roundUsd = (x: number) => Math.round(x * 10_000) / 10_000;

/** The estimate of running `plan` on the run model `alias` (inside the team's transaction). */
/** The run model's catalog prices per million tokens, when it has both. */
async function pricesOf(tx: KobeTx, alias: string) {
  const res = await tx.execute<Row>(sql`
    SELECT input_usd_per_mtok AS input, output_usd_per_mtok AS output FROM model_catalog
     WHERE alias = ${alias}`);
  const r = res.rows[0];
  const input = num(r?.input);
  const output = num(r?.output);
  return input === null || output === null ? null : { input, output };
}

/** The suite-size estimate: no history of the caller's on the model. */
async function suiteSize(tx: KobeTx, input: EstimateInput): Promise<SkillEvalEstimate> {
  const executions = input.plan.length;
  const prices = await pricesOf(tx, input.runModel);
  const byId = new Map(input.suite.cases.map((c) => [c.id, c]));
  let usd = 0;
  for (const e of input.plan) {
    const c = byId.get(e.caseId);
    if (!c) continue;
    const fixtures = c.files.reduce((n, f) => n + (input.fixtureBytes?.(f) ?? 0), 0);
    const context = ESTIMATE_BASE_INPUT_TOKENS + Math.ceil((c.prompt.length + fixtures) / 4);
    const tokensIn = ESTIMATE_TURNS * context + (c.expect.judge ? ESTIMATE_JUDGE_TOKENS.input : 0);
    const tokensOut =
      ESTIMATE_TURNS * ESTIMATE_OUTPUT_TOKENS + (c.expect.judge ? ESTIMATE_JUDGE_TOKENS.output : 0);
    if (prices) usd += (tokensIn * prices.input + tokensOut * prices.output) / 1_000_000;
  }
  const waves = Math.ceil(executions / Math.max(1, input.concurrency));
  return skillEvalEstimateSchema.parse({
    executions,
    costUsd: prices ? roundUsd(usd) : null,
    minutes: waves * ESTIMATE_MINUTES,
    basis: "suite_size",
  });
}

export interface EstimateInput {
  readonly teamId: string;
  /** The caller: whose own history counts unless `teamWide`. */
  readonly userId: string;
  /** The caller may see team usage (`team.budgets.manage`): team-wide means. */
  readonly teamWide: boolean;
  readonly runModel: string;
  readonly suite: SkillEvalSuite;
  readonly plan: readonly SkillEvalPlannedExecution[];
  readonly concurrency: number;
  /** A fixture's size in bytes (the package's), for the suite-size fallback. */
  readonly fixtureBytes?: (path: string) => number;
}

/** The estimate of running `plan` on the run model (inside the team's transaction). */
export async function estimateSkillEvalIn(
  tx: KobeTx,
  input: EstimateInput,
): Promise<SkillEvalEstimate> {
  const executions = input.plan.length;
  const only = input.teamWide ? null : input.userId;
  const history = await evalHistory(tx, input.teamId, input.runModel, only);
  let means: Means | null = history.means;
  let judgeUsd = history.judgeUsd;
  if (!means) {
    const model = await gatewayModelOf(tx, input.runModel);
    means = model ? await runHistory(tx, input.teamId, model, only) : null;
  }
  if (!means) return suiteSize(tx, input);
  judgeUsd ??= await judgeCallMean(tx, input.teamId, only);
  const judged = new Set(input.suite.cases.filter((c) => c.expect.judge).map((c) => c.id));
  const judgedRuns = input.plan.filter((e) => judged.has(e.caseId)).length;
  const costUsd =
    means.costUsd === null
      ? null
      : roundUsd(means.costUsd * executions + (judgeUsd ?? 0) * judgedRuns);
  const waves = Math.ceil(executions / Math.max(1, input.concurrency));
  const minutes = Math.max(1, Math.ceil((waves * means.durationMs) / 60_000));
  return skillEvalEstimateSchema.parse({
    executions,
    costUsd,
    minutes,
    basis: input.teamWide ? "team_history" : "own_history",
  });
}

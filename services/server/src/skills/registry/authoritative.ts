import { SYSTEM_ACTOR, sql, type KobeTx } from "@kobe/db";
import {
  scorecardForProvenance,
  type SkillEvalJudgeModel,
  type SkillEvalScorecard,
} from "@kobe/protocol";
import { recordAudit } from "../../audit/record.js";
import { logger } from "../../logger.js";
import { registryTeamFor } from "./settings.js";

/**
 * The authoritative catalog scorecard (KOBE-335, SK23): the Registry team's full re-run of a
 * Registry version, judged by the Site judge. When the re-run completes, its scorecard is reduced
 * to the catalog card (numbers only, `scorecardForProvenance`) and stored on the version with what
 * Approve checks (`rerun`: the Registry team, the eval run, the Site judge's alias). It is stored
 * only while the version is still open, the run's team is still the Registry team and the run
 * evaluated the version's own package; a later re-run replaces it.
 */

export interface RerunFacts {
  /** The Registry team the re-run ran in (its budget paid for it). */
  readonly teamId: string;
  readonly evalRunId: string;
  /** Who started it (a reviewer neither the submitter nor the confirmer, review-335 M3). */
  readonly startedBy: string | null;
  /** The Site judge's alias, when the suite has judged cases. */
  readonly judgeAlias: string | null;
  /** The provider model that alias named then (`provider/model`, review-335 L4). */
  readonly judgeModel: string | null;
}

/** The current state Approve checks a card against (review-335 L4). */
export interface ApproveNow {
  readonly registryTeamId: string | null;
  readonly siteJudgeAlias: string | null;
  /** The provider model the Site judge alias names now. */
  readonly siteJudgeModel: string | null;
  readonly at: Date;
}

/** A card older than this is stale: models and the Site's setup move on (review-335 L4). */
export const AUTHORITATIVE_MAX_AGE_DAYS = 30;

/** `provider/model` an alias names in the catalog now; null when none. */
export async function catalogModelOf(tx: KobeTx, alias: string | null): Promise<string | null> {
  if (!alias) return null;
  const res = await tx.execute<{ provider_id: string; model: string }>(sql`
    SELECT provider_id, model FROM model_catalog WHERE alias = ${alias}`);
  const r = res.rows[0];
  return r ? `${r.provider_id}/${r.model}` : null;
}

const OPEN = ["submitted", "in_review"];

/** Called by the eval store in the transaction that completes a `registry` eval run. */
export async function recordAuthoritativeScorecard(
  tx: KobeTx,
  run: {
    readonly teamId: string;
    readonly evalRunId: string;
    readonly versionId: string;
    readonly card: SkillEvalScorecard;
    readonly judgeModel: SkillEvalJudgeModel | null;
    readonly startedBy: string | null;
  },
): Promise<boolean> {
  const registryTeam = await registryTeamFor(tx);
  if (registryTeam !== run.teamId || run.card.mode !== "full") {
    logger.warn(
      { evalRunId: run.evalRunId, versionId: run.versionId },
      "registry: a re-run finished outside the Registry team; not authoritative",
    );
    return false;
  }
  if (run.judgeModel && run.judgeModel.source !== "site") return false;
  // A card the catalog contract refuses never blocks the eval's completion (review-335 L2): the
  // run completes, the version just gets no authoritative card from it.
  let card: ReturnType<typeof scorecardForProvenance>;
  try {
    card = scorecardForProvenance(run.card, new Date().toISOString());
  } catch (err) {
    logger.warn(
      { err, evalRunId: run.evalRunId, versionId: run.versionId },
      "registry: a re-run's scorecard doesn't make a catalog card; not authoritative",
    );
    return false;
  }
  const judgeAlias = run.judgeModel?.alias ?? null;
  const rerun: RerunFacts = {
    teamId: run.teamId,
    evalRunId: run.evalRunId,
    startedBy: run.startedBy,
    judgeAlias,
    judgeModel: await catalogModelOf(tx, judgeAlias),
  };
  const res = await tx.execute<{ id: string }>(sql`
    UPDATE registry_versions
       SET authoritative_scorecard = ${JSON.stringify({ ...card, rerun })}::jsonb,
           updated_at = now()
     WHERE id = ${run.versionId} AND package_hash = ${card.packageHash}
       AND state::text IN (${sql.join(
         OPEN.map((s) => sql`${s}`),
         sql`, `,
       )})
    RETURNING id`);
  if (res.rows.length === 0) return false;
  await recordAudit(tx, {
    action: "registry.authoritative_scorecard",
    actor: SYSTEM_ACTOR,
    target: { registryVersionId: run.versionId, evalRunId: run.evalRunId },
  });
  return true;
}

/**
 * What Approve needs of the card beyond its package (L2): this Registry team, the Site judge (its
 * alias and the model it names), younger than {@link AUTHORITATIVE_MAX_AGE_DAYS}, and at least one
 * execution with the skill that didn't error or time out (review-335 L4).
 */
export function rerunProblem(
  card: Record<string, unknown>,
  now: ApproveNow,
): { readonly code: string; readonly message: string } | null {
  const rerun = card.rerun as Partial<RerunFacts> | undefined;
  const stale = (why: string) => ({
    code: "authoritative_scorecard_stale",
    message: `The authoritative scorecard ${why}: re-run the evals.`,
  });
  if (!rerun || rerun.teamId !== now.registryTeamId)
    return stale("didn't run in the current Registry team");
  const judge = card.judge as { source?: unknown } | undefined;
  if (
    judge &&
    (judge.source !== "site" ||
      rerun.judgeAlias !== now.siteJudgeAlias ||
      rerun.judgeModel !== now.siteJudgeModel)
  )
    return stale("wasn't judged by the current Site judge");
  const at = typeof card.at === "string" ? Date.parse(card.at) : NaN;
  if (!(now.at.getTime() - at <= AUTHORITATIVE_MAX_AGE_DAYS * 86_400_000))
    return stale(`is older than ${AUTHORITATIVE_MAX_AGE_DAYS} days`);
  const runs = (
    card.executions as
      { with?: { executions: number; errored: number; timedOut: number } } | undefined
  )?.with;
  if (runs && runs.errored + runs.timedOut >= runs.executions)
    return {
      code: "authoritative_scorecard_errored",
      message: "Every execution of the re-run errored or timed out: re-run the evals.",
    };
  return null;
}

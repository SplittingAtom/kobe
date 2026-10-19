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
  /** The Site judge's alias, when the suite has judged cases. */
  readonly judgeAlias: string | null;
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
  const card = scorecardForProvenance(run.card, new Date().toISOString());
  const rerun: RerunFacts = {
    teamId: run.teamId,
    evalRunId: run.evalRunId,
    judgeAlias: run.judgeModel?.alias ?? null,
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

/** What Approve needs of the card beyond its package (L2): this Registry team, the Site judge. */
export function rerunProblem(
  card: Record<string, unknown>,
  now: { readonly registryTeamId: string | null; readonly siteJudgeAlias: string | null },
): { readonly code: string; readonly message: string } | null {
  const rerun = card.rerun as Partial<RerunFacts> | undefined;
  const stale = (why: string) => ({
    code: "authoritative_scorecard_stale",
    message: `The authoritative scorecard ${why}: re-run the evals.`,
  });
  if (!rerun || rerun.teamId !== now.registryTeamId)
    return stale("didn't run in the current Registry team");
  const judge = card.judge as { source?: unknown } | undefined;
  if (judge && (judge.source !== "site" || rerun.judgeAlias !== now.siteJudgeAlias))
    return stale("wasn't judged by the current Site judge");
  return null;
}

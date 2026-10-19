import { sql, type KobeTx } from "@kobe/db";
import { catalogModelOf, rerunProblem, type ApproveNow } from "./authoritative.js";

/**
 * Guards the Registry's Approve (KOBE-334, SK22, SK23) shares with the tickets after it.
 *
 * - **The authoritative scorecard** (SK23): Approve needs the Registry team's re-run with the
 *   Site judge (KOBE-335 writes `authoritative_scorecard`). Until a version has one, Approve fails
 *   closed with {@link AUTHORITATIVE_SCORECARD_MISSING}; KOBE-335 extends
 *   {@link authoritativeScorecardProblem} (freshness, the package it ran on) without touching
 *   Approve.
 * - **Separation of duties** (SK22): nobody approves their own submission, and the Team admin who
 *   confirmed a Builder's promotion doesn't approve it either (review-c2 (b)). A single-admin Site
 *   may: {@link soleReviewer} mirrors the database's own rule (`registry_versions_review_guard`,
 *   0133), read under the same site admin-set lock.
 */

export const AUTHORITATIVE_SCORECARD_MISSING = {
  code: "authoritative_scorecard_missing",
  message:
    "Authoritative scorecard missing: re-run the evals in the Registry team with the Site judge before approving.",
} as const;

export interface ScorecardProblem {
  readonly code: string;
  readonly message: string;
}

/**
 * Why the version's authoritative scorecard doesn't let it be approved; null when it does. The
 * card must name this version's own package (review L2) and come from a re-run in the current
 * Registry team, judged by the current Site judge when the suite has judged cases (KOBE-335).
 */
export function authoritativeScorecardProblem(
  version: {
    readonly authoritativeScorecard: Record<string, unknown> | null;
    readonly packageHash: string;
  },
  now: ApproveNow,
): ScorecardProblem | null {
  const card = version.authoritativeScorecard;
  if (!card) return AUTHORITATIVE_SCORECARD_MISSING;
  if (card.packageHash !== version.packageHash)
    return {
      code: "authoritative_scorecard_stale",
      message: "The authoritative scorecard is from another package: re-run the evals.",
    };
  return rerunProblem(card, now);
}

/** The Site judge: its alias and the `provider/model` it names now (null: none set). */
export async function siteJudge(
  tx: KobeTx,
): Promise<{ readonly alias: string | null; readonly model: string | null }> {
  const res = await tx.execute<{ alias: string | null }>(sql`
    SELECT judge_alias AS alias FROM site_skill_settings WHERE id = 1`);
  const alias = res.rows[0]?.alias ?? null;
  return { alias, model: await catalogModelOf(tx, alias) };
}

/**
 * Whether `userId` is the Site's only reviewer: an active Site admin (or the Owner) while no other
 * active Site admin and no other active Skill reviewer exists. Takes the site admin-set lock, which
 * role, grant and deactivation changes also take, so the answer holds until the transaction ends.
 */
export async function soleReviewer(tx: KobeTx, userId: string): Promise<boolean> {
  await tx.execute(sql`SELECT public.break_glass_lock_admin_set()`);
  const res = await tx.execute<{ admin: boolean; others: boolean }>(sql`
    SELECT public.break_glass_is_site_admin(${userId}) AS admin,
      (EXISTS (SELECT 1 FROM site_roles r JOIN users u ON u.id = r.user_id
                WHERE r.user_id <> ${userId} AND u.deactivated_at IS NULL)
        OR EXISTS (SELECT 1 FROM site_grants g JOIN users u ON u.id = g.user_id
                    WHERE g."grant" = 'skill_reviewer' AND g.user_id <> ${userId}
                      AND u.deactivated_at IS NULL)) AS others`);
  const row = res.rows[0];
  return row?.admin === true && row.others === false;
}

/** Whether `userId` is an active Site admin or the Owner (the Block-verdict override, SK32). */
export async function isSiteAdmin(tx: KobeTx, userId: string): Promise<boolean> {
  const res = await tx.execute<{ admin: boolean }>(sql`
    SELECT public.break_glass_is_site_admin(${userId}) AS admin`);
  return res.rows[0]?.admin === true;
}

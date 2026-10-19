import { sql, type KobeTx } from "@kobe/db";

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

/** Why the version's authoritative scorecard doesn't let it be approved; null when it does. */
export function authoritativeScorecardProblem(version: {
  readonly authoritativeScorecard: Record<string, unknown> | null;
  readonly packageHash: string;
}): ScorecardProblem | null {
  const card = version.authoritativeScorecard;
  if (!card) return AUTHORITATIVE_SCORECARD_MISSING;
  // A card that names a package names this one (the re-run evaluates the version's own package).
  if (typeof card.packageHash === "string" && card.packageHash !== version.packageHash)
    return {
      code: "authoritative_scorecard_stale",
      message: "The authoritative scorecard is from another package: re-run the evals.",
    };
  return null;
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

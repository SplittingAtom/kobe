import { and, eq, teamSkillReviews, type KobeTx, type TeamRole } from "@kobe/db";
import { teamRoleAllows } from "../../authz/permissions.js";
import { readPersonalSkillsDisabled } from "../settings.js";

/**
 * The team's personal-skill gates on a test chat (KOBE-323 review S1, coordinator): a member's
 * draft is their own skill content, so a test of it is held to what the team decided for personal
 * skills.
 *
 * - The team turned personal skills off: only its Builders and Team admins may test drafts here
 *   (they may make the draft a team skill anyway, which the team reviews).
 * - The team declined a personal skill version (KOBE-99) whose runtime hash is these exact files:
 *   nobody tests them here.
 */
export type TestGate = "personal_skills_disabled" | "skill_declined";

export const GATE_MESSAGES: Readonly<Record<TestGate, string>> = {
  personal_skills_disabled:
    "This team has turned personal skills off, so only its Builders and Team admins can test drafts here.",
  skill_declined:
    "This team declined a personal skill with exactly these files, so the draft can't be tested here.",
};

export async function testGate(
  tx: KobeTx,
  who: { readonly teamId: string; readonly role: TeamRole },
  sha256: string,
): Promise<TestGate | null> {
  if (
    !teamRoleAllows(who.role, "team.skills.publish") &&
    (await readPersonalSkillsDisabled(tx, who.teamId))
  )
    return "personal_skills_disabled";
  const [declined] = await tx
    .select({ version: teamSkillReviews.version })
    .from(teamSkillReviews)
    .where(
      and(
        eq(teamSkillReviews.teamId, who.teamId),
        eq(teamSkillReviews.scope, "personal"),
        eq(teamSkillReviews.contentHash, sha256),
        eq(teamSkillReviews.status, "rejected"),
      ),
    )
    .limit(1);
  return declined ? "skill_declined" : null;
}

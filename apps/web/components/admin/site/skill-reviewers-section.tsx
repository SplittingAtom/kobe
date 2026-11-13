"use client";

import { SiteGrantSection, type SiteGrantCopy } from "./site-grant-section";

export const REVIEWER_HINT =
  "Skill reviewers see the Registry queue and may claim, comment, approve, request changes and reject. They can't block, withdraw, revoke, tag Default or change Registry settings. Kobe adds them to the Registry team, where re-runs run; a Site admin needs the grant for that too. Another admin gives it to you; on a single-admin Site you may give it to yourself (flagged).";

const REVIEWER_COPY: SiteGrantCopy = {
  grant: "skill_reviewer",
  title: "Skill reviewers",
  hint: REVIEWER_HINT,
  name: "Skill reviewer",
  pickerLabel: "Reviewer",
  takeDescription: "They lose the Registry queue at once. They stay in the Registry team.",
  offerAdmins: true,
};

/**
 * Skill reviewers (KOBE-331, SK22): a grant beside the role ladder, given and taken by the Owner
 * or a Site admin. Site admins and the Owner may hold it too (review-336 decision), given by
 * another admin; oneself only on a single-admin Site, shown "self-granted".
 */
export function SkillReviewersSection() {
  return <SiteGrantSection copy={REVIEWER_COPY} />;
}

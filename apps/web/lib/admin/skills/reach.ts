/** The rule that decides which runs get a team skill (KOBE-297), shown where skills are made. */
export const TEAM_SKILL_RULE =
  "A team skill reaches the agents that name it; On by default reaches every agent that isn't exclusive (members may turn it off), Available only members who turn it on, Required every run (team admins only), Hidden only agents that name it. Only approved versions are ever used.";

/** A skill slug as SKILL.md frontmatter allows it (server skills/bundle.ts `SKILL_NAME`). */
const SKILL_SLUG = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

export function isSkillSlug(value: string): boolean {
  return SKILL_SLUG.test(value);
}

/** The builder link that opens a team agent's draft with `slug` added to its skills. */
export function addSkillHref(agentId: string, slug: string): string {
  return `/admin/team/agents/${encodeURIComponent(agentId)}?addSkill=${encodeURIComponent(slug)}`;
}

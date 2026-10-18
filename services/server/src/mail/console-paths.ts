/**
 * Web pages that emails link to (KOBE-257): one place for the console URLs, so a route move in
 * apps/web is one edit here. The site console is `/admin/site` (it was `/admin/site`, which
 * still redirects); the team console is `/admin/team`.
 */
const SITE_CONSOLE = "/admin/site";
const TEAM_CONSOLE = "/admin/team";

export const CONSOLE_PATHS = {
  siteBreakGlass: `${SITE_CONSOLE}/break-glass`,
  siteConnectors: `${SITE_CONSOLE}/connectors`,
  siteUsage: `${SITE_CONSOLE}/usage`,
  teamBreakGlass: `${TEAM_CONSOLE}/break-glass`,
  teamBudgets: `${TEAM_CONSOLE}/budgets`,
  teamEgress: `${TEAM_CONSOLE}/egress`,
  teamSkillReview: `${TEAM_CONSOLE}/skill-review`,
  mySkills: "/me/skills",
  /** The chat: members see their own budget there (the budget banner); no admin console needed. */
  chat: "/",
} as const;

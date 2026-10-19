import type { TeamRole } from "@kobe/db";
import type { SiteGrant } from "@kobe/protocol";

/**
 * The fixed role model (spec D8) as one permission matrix. Each permission names the least
 * privileged role that holds it; roles are hierarchical (Owner > Admin > User;
 * team_admin > builder > member). Site and team permissions are separate maps: a site role
 * never grants a team permission, so site admins reach team content only through break-glass.
 * Custom roles are out of scope for v1.
 */

/** Site role as stored in `site_roles`; null is a plain User. */
export type SiteRole = "owner" | "admin" | null;

const SITE_RANK = { user: 0, admin: 1, owner: 2 } as const;
type SiteLevel = keyof typeof SITE_RANK;

const TEAM_RANK: Readonly<Record<TeamRole, number>> = { member: 0, builder: 1, team_admin: 2 };

export const SITE_PERMISSIONS = {
  "site.settings.manage": "admin",
  "site.users.manage": "admin",
  "site.teams.manage": "admin",
  "site.models.manage": "admin",
  "site.policy.manage": "admin",
  "site.connectors.manage": "admin",
  "site.gallery.manage": "admin",
  "site.blocklist.manage": "admin",
  /** Approve a team skill version whose scan is Block (KOBE-312), with a reason; audited. */
  "site.skills.override_scan": "admin",
  /** Catalog tags: the topic vocabulary, the Default system tag and Default moves (KOBE-314). */
  "site.skills.catalog.manage": "admin",
  /** The Skill Registry queue and every review action (KOBE-331, SK22); see skillReviewAllows. */
  "site.skills.review": "admin",
  /** Give and take site grants such as Skill reviewer (KOBE-331, SK22). */
  "site.grants.manage": "admin",
  "site.egress.manage": "admin",
  "site.retention.manage": "admin",
  "site.legal_hold.manage": "admin",
  "site.audit.read": "admin",
  // Usage and spend across every team (KOBE-43, D30): counts and costs, never team content.
  "site.usage.read": "admin",
  // The site budget and default per-user request rate (KOBE-42, D30).
  "site.budgets.manage": "admin",
  "site.break_glass.request": "admin",
  // D10: a second Admin or the Owner approves (enforced again by the database trigger).
  "site.break_glass.approve": "admin",
  "site.roles.manage": "owner",
  "site.ownership.transfer": "owner",
} as const satisfies Record<`site.${string}`, SiteLevel>;

export const TEAM_PERMISSIONS = {
  // Member: chat and use what the team offers; personal items and schedules.
  "team.read": "member",
  "team.members.read": "member",
  "team.chat": "member",
  "team.agents.use": "member",
  "team.personal.create": "member",
  "team.grants.connect": "member",
  "team.schedules.personal": "member",
  // Builder: create and publish to the team.
  "team.agents.build": "builder",
  "team.agents.publish": "builder",
  "team.skills.publish": "builder",
  "team.projects.create": "builder",
  // Team admin: run the team.
  "team.members.manage": "team_admin",
  "team.models.manage": "team_admin",
  "team.budgets.manage": "team_admin",
  "team.connectors.manage": "team_admin",
  "team.policy.manage": "team_admin",
  "team.egress.manage": "team_admin",
  "team.skills.review": "team_admin",
  /** Uninstall catalog skills (a Default one records an opt-out) and reinstall defaults (SK7). */
  "team.skills.installs.manage": "team_admin",
  "team.retention.manage": "team_admin",
  // The pre-publish Orbit eval gate: switch and threshold (KOBE-93).
  "team.eval.manage": "team_admin",
  // The team's memory switches (KOBE-155, D24).
  "team.memory.manage": "team_admin",
  // The team's audit view (D6): events recorded for this team only (KOBE-15).
  "team.audit.read": "team_admin",
  "team.schedules.pause": "team_admin",
  "team.agents.suspend": "team_admin",
  // Edit or delete any team agent, not only your own (KOBE-45; like projects, D23).
  "team.agents.manage": "team_admin",
  "team.projects.manage": "team_admin",
} as const satisfies Record<`team.${string}`, TeamRole>;

export type SitePermission = keyof typeof SITE_PERMISSIONS;
export type TeamPermission = keyof typeof TEAM_PERMISSIONS;

export function siteRoleAllows(role: SiteRole, permission: SitePermission): boolean {
  return SITE_RANK[role ?? "user"] >= SITE_RANK[SITE_PERMISSIONS[permission]];
}

export function teamRoleAllows(role: TeamRole | null, permission: TeamPermission): boolean {
  return role !== null && TEAM_RANK[role] >= TEAM_RANK[TEAM_PERMISSIONS[permission]];
}

/** Sorted site permissions of a role (for clients deciding what to show). */
export function sitePermissionsFor(role: SiteRole): SitePermission[] {
  return (Object.keys(SITE_PERMISSIONS) as SitePermission[])
    .filter((p) => siteRoleAllows(role, p))
    .sort();
}

/** Sorted team permissions of a role; none for a non-member. */
export function teamPermissionsFor(role: TeamRole | null): TeamPermission[] {
  return (Object.keys(TEAM_PERMISSIONS) as TeamPermission[])
    .filter((p) => teamRoleAllows(role, p))
    .sort();
}

/**
 * Actions on the Skill Registry (KOBE-331, SK22). Site admins and the Owner (`site.skills.review`)
 * may do all of them; the **Skill reviewer** grant, checked beside the role ladder, allows only
 * {@link SKILL_REVIEWER_ACTIONS}: never block, withdraw, revoke, tag Default or change settings.
 */
export const SKILL_REVIEW_ACTIONS = [
  "queue.read",
  "claim",
  "comment",
  "approve",
  "request_changes",
  "reject",
  "reject_and_block",
  "withdraw",
  "revoke",
  "tag_default",
  "settings",
] as const;
export type SkillReviewAction = (typeof SKILL_REVIEW_ACTIONS)[number];

const SKILL_REVIEWER_ACTIONS: ReadonlySet<SkillReviewAction> = new Set([
  "queue.read",
  "claim",
  "comment",
  "approve",
  "request_changes",
  "reject",
]);

export interface SkillReviewWho {
  readonly siteRole: SiteRole;
  readonly grants: readonly SiteGrant[];
}

export function skillReviewAllows(who: SkillReviewWho, action: SkillReviewAction): boolean {
  if (siteRoleAllows(who.siteRole, "site.skills.review")) return true;
  return who.grants.includes("skill_reviewer") && SKILL_REVIEWER_ACTIONS.has(action);
}

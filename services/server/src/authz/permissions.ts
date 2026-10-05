import type { TeamRole } from "@kobe/db";

/**
 * The fixed role model (spec D8) as one permission matrix. Each permission names the least
 * privileged role that holds it; roles are hierarchical (Owner > Admin > User;
 * team_admin > builder > member). Install and team permissions are separate maps: an install role
 * never grants a team permission, so install admins reach team content only through break-glass.
 * Custom roles are out of scope for v1.
 */

/** Install role as stored in `install_roles`; null is a plain User. */
export type InstallRole = "owner" | "admin" | null;

const INSTALL_RANK = { user: 0, admin: 1, owner: 2 } as const;
type InstallLevel = keyof typeof INSTALL_RANK;

const TEAM_RANK: Readonly<Record<TeamRole, number>> = { member: 0, builder: 1, team_admin: 2 };

export const INSTALL_PERMISSIONS = {
  "install.settings.manage": "admin",
  "install.users.manage": "admin",
  "install.teams.manage": "admin",
  "install.models.manage": "admin",
  "install.policy.manage": "admin",
  "install.connectors.manage": "admin",
  "install.gallery.manage": "admin",
  "install.blocklist.manage": "admin",
  "install.egress.manage": "admin",
  "install.retention.manage": "admin",
  "install.legal_hold.manage": "admin",
  "install.audit.read": "admin",
  // Usage and spend across every team (KOBE-43, D30): counts and costs, never team content.
  "install.usage.read": "admin",
  // The install budget and default per-user request rate (KOBE-42, D30).
  "install.budgets.manage": "admin",
  "install.break_glass.request": "admin",
  // D10: a second Admin or the Owner approves (enforced again by the database trigger).
  "install.break_glass.approve": "admin",
  "install.roles.manage": "owner",
  "install.ownership.transfer": "owner",
} as const satisfies Record<`install.${string}`, InstallLevel>;

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
  "team.retention.manage": "team_admin",
  // The pre-publish Orbit eval gate: switch and threshold (KOBE-93).
  "team.eval.manage": "team_admin",
  // The team's audit view (D6): events recorded for this team only (KOBE-15).
  "team.audit.read": "team_admin",
  "team.schedules.pause": "team_admin",
  "team.agents.suspend": "team_admin",
  // Edit or delete any team agent, not only your own (KOBE-45; like projects, D23).
  "team.agents.manage": "team_admin",
  "team.projects.manage": "team_admin",
} as const satisfies Record<`team.${string}`, TeamRole>;

export type InstallPermission = keyof typeof INSTALL_PERMISSIONS;
export type TeamPermission = keyof typeof TEAM_PERMISSIONS;

export function installRoleAllows(role: InstallRole, permission: InstallPermission): boolean {
  return INSTALL_RANK[role ?? "user"] >= INSTALL_RANK[INSTALL_PERMISSIONS[permission]];
}

export function teamRoleAllows(role: TeamRole | null, permission: TeamPermission): boolean {
  return role !== null && TEAM_RANK[role] >= TEAM_RANK[TEAM_PERMISSIONS[permission]];
}

/** Sorted install permissions of a role (for clients deciding what to show). */
export function installPermissionsFor(role: InstallRole): InstallPermission[] {
  return (Object.keys(INSTALL_PERMISSIONS) as InstallPermission[])
    .filter((p) => installRoleAllows(role, p))
    .sort();
}

/** Sorted team permissions of a role; none for a non-member. */
export function teamPermissionsFor(role: TeamRole | null): TeamPermission[] {
  return (Object.keys(TEAM_PERMISSIONS) as TeamPermission[])
    .filter((p) => teamRoleAllows(role, p))
    .sort();
}

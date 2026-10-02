/**
 * Which actions a console offers, mirroring the server's rules so people aren't shown buttons
 * that can only fail. The server decides; these never grant anything.
 */
import type { InstallUser } from "./api/install";
import type { InstallRole } from "./nav/types";

/** Deactivation (KOBE-13): Admins act on Users, only the Owner on Admins; nobody on the Owner or themselves. */
export function canChangeActivation(
  me: { readonly userId: string; readonly role: InstallRole },
  target: Pick<InstallUser, "id" | "installRole">,
): boolean {
  if (target.id === me.userId || target.installRole === "owner") return false;
  if (target.installRole === "admin") return me.role === "owner";
  return me.role === "owner" || me.role === "admin";
}

/** Granting/revoking Admin and transferring ownership are the Owner's (KOBE-14). */
export function canManageInstallRoles(role: InstallRole): boolean {
  return role === "owner";
}

/** Turning required 2FA off weakens every account: Owner only (install-settings route). */
export function canTurnOffRequiredTwoFactor(role: InstallRole): boolean {
  return role === "owner";
}

/** Suggests a team slug from its name, in the server's format (≤ 32, [a-z0-9-], no edge hyphens). */
export function slugFromTeamName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 32)
    .replace(/^-+|-+$/g, "");
}

export const TEAM_SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

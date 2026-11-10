import { projectPermissions } from "@kobe/protocol";
import type { FileEntry } from "../files/api";
import type { TeamRole } from "../teams";

/**
 * Promote to project (KOBE-586, projects-in-conversations PF1-PF2): which Files rows offer it and
 * the dialog's one rule. The server decides again (permission, limits, the folder's contents).
 */

/** The project name's longest form (protocol `PROJECT_NAME_MAX`). */
export const PROMOTE_NAME_MAX = 100;

/** Team admins and contributors create projects (`team.projects.create`, PR4); members never. */
export function canCreateProjects(role: TeamRole | null | undefined): boolean {
  return role != null && projectPermissions(role, undefined).create;
}

/** PF1: a folder of My files (not `uploads/`, not under Projects), for those who create projects. */
export function offersPromote(entry: FileEntry, canCreate: boolean): boolean {
  return canCreate && entry.type === "dir" && entry.area === "workspace";
}

/** Why `name` can't name the project, or null. */
export function promoteNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Type a name for the project.";
  if (trimmed.length > PROMOTE_NAME_MAX) {
    return `A project name has at most ${PROMOTE_NAME_MAX} characters.`;
  }
  return null;
}

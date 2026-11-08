import type { ProjectRole, ProjectVisibility } from "@kobe/protocol";

/**
 * Temporary bridge (KOBE-576, Workspaces WS-1): the database still has `members_mode`
 * (team|selected) and `project_members.role` (owner|member). The protocol now speaks
 * `visibility` and owner|editor|reader. KOBE-577 migrates the columns (MG2, MG3) and KOBE-578
 * deletes this file; until then an explicit `member` row reads as `editor`; a requested `reader` is refused with 422
 * `role_not_supported_yet` (it would read back as editor) until the migration.
 */
export type DbProjectRole = "owner" | "member";
export type DbMembersMode = "team" | "selected";

export const visibilityOf = (mode: DbMembersMode): ProjectVisibility =>
  mode === "team" ? "workspace" : "restricted";
export const membersModeOf = (visibility: ProjectVisibility): DbMembersMode =>
  visibility === "workspace" ? "team" : "selected";
export const roleFromDb = (role: DbProjectRole): ProjectRole =>
  role === "owner" ? "owner" : "editor";
export const roleToDb = (role: ProjectRole): DbProjectRole =>
  role === "owner" ? "owner" : "member";

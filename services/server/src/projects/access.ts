import { and, eq, projectMembers, projects, sql, teamMembers, type KobeTx } from "@kobe/db";
import { projectPermissions, type ProjectAction, type ProjectRole } from "@kobe/protocol";
import type { TeamRole } from "@kobe/db";

export type ProjectRow = typeof projects.$inferSelect;

/** A caller's standing in one project: the one place `projectPermissions` is fed. */
export interface ProjectAccess {
  readonly project: ProjectRow;
  /** Effective role: explicit row, else an implicit `member` (mode `team`), else none. */
  readonly role: ProjectRole | undefined;
  readonly can: Record<ProjectAction, boolean>;
}

/** The effective project role of a team member (explicit row wins; mode `team` implies member). */
export function effectiveRole(
  mode: ProjectRow["membersMode"],
  explicit: ProjectRole | undefined,
): ProjectRole | undefined {
  if (explicit !== undefined) return explicit;
  return mode === "team" ? "member" : undefined;
}

async function teamRoleOf(tx: KobeTx, teamId: string, userId: string): Promise<TeamRole | null> {
  const [row] = await tx
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
  return row?.role ?? null;
}

/**
 * The caller's access to `projectId`, or undefined when the project does not exist in the team or
 * the caller may not view it (callers answer 404 for both: non-members cannot tell it exists).
 */
export async function loadAccess(
  tx: KobeTx,
  viewer: { teamId: string; userId: string },
  projectId: string,
  options: { lock?: boolean } = {},
): Promise<ProjectAccess | undefined> {
  const query = tx
    .select()
    .from(projects)
    .where(and(eq(projects.teamId, viewer.teamId), eq(projects.id, projectId)));
  const [project] = await (options.lock ? query.for("update") : query);
  if (!project) return undefined;
  const teamRole = await teamRoleOf(tx, viewer.teamId, viewer.userId);
  if (teamRole === null) return undefined;
  const [member] = await tx
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.teamId, viewer.teamId),
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, viewer.userId),
      ),
    );
  const role = effectiveRole(project.membersMode, member?.role);
  const can = projectPermissions(teamRole, role);
  return can.view ? { project, role, can } : undefined;
}

/** Team role of `userId` (for create checks outside a project). */
export const teamRoleFor = teamRoleOf;

/**
 * Active-team projects `userId` is a member of (explicitly, or implicitly in mode `team`).
 */
export async function memberProjectIds(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<readonly string[]> {
  const res = await tx.execute<{ id: string }>(sql`
    SELECT p.id FROM projects p
     WHERE p.team_id = ${teamId}
       AND (p.members_mode = 'team'
            OR EXISTS (SELECT 1 FROM project_members m
                        WHERE m.team_id = p.team_id AND m.project_id = p.id
                          AND m.user_id = ${userId}))`);
  return res.rows.map((r) => r.id);
}

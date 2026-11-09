import { and, eq, projectMembers, projects, sql, teamMembers, type KobeTx } from "@kobe/db";
import {
  effectiveProjectRole,
  projectPermissions,
  type ProjectAction,
  type ProjectRole,
} from "@kobe/protocol";
import type { TeamRole } from "@kobe/db";

export type ProjectRow = typeof projects.$inferSelect;

/** A caller's standing in one project: the one place `projectPermissions` is fed. */
export interface ProjectAccess {
  readonly project: ProjectRow;
  /** Effective role: explicit row, else an implicit `reader` (visibility `workspace`), else none. */
  readonly role: ProjectRole | undefined;
  readonly can: Record<ProjectAction, boolean>;
}

/** The effective project role of a team member (PR3: explicit row wins; `workspace` implies reader). */
export function effectiveRole(
  visibility: ProjectRow["visibility"],
  explicit: ProjectRole | undefined,
): ProjectRole | undefined {
  return effectiveProjectRole(explicit, visibility);
}

/** The one place a role becomes rights: effective role and `projectPermissions` (PR3). */
export function decide(
  teamRole: TeamRole,
  explicit: ProjectRole | undefined,
  visibility: ProjectRow["visibility"],
): { role: ProjectRole | undefined; can: Record<ProjectAction, boolean> } {
  return {
    role: effectiveRole(visibility, explicit),
    can: projectPermissions(teamRole, explicit, visibility),
  };
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
  const { role, can } = decide(teamRole, member?.role, project.visibility);
  return can.view ? { project, role, can } : undefined;
}

/** Team role of `userId` (for create checks outside a project). */
export const teamRoleFor = teamRoleOf;

/**
 * SQL condition: `userId` may view project `p` (PR2/PR3): a team admin views every project of the
 * workspace, everyone else needs visibility `workspace` or an explicit row. Mirrors
 * `projectPermissions(...).view` for set queries (lists, mounts, shared-thread reads).
 */
export function viewableBy(userId: string | ReturnType<typeof sql>, alias = "p") {
  const p = sql.raw(alias);
  return sql`(${p}.visibility = 'workspace'
           OR EXISTS (SELECT 1 FROM project_members m
                       WHERE m.team_id = ${p}.team_id AND m.project_id = ${p}.id
                         AND m.user_id = ${userId})
           OR EXISTS (SELECT 1 FROM team_members tm
                       WHERE tm.team_id = ${p}.team_id AND tm.user_id = ${userId}
                         AND tm.role = 'team_admin'))`;
}

/**
 * Active-team projects `userId` may view (visibility `workspace`, an explicit row, or any project
 * for a team admin): threads shared to them are readable (PR3 "read conversations shared to the
 * project"). Nothing for someone who is not in the team.
 */
export async function memberProjectIds(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<readonly string[]> {
  const res = await tx.execute<{ id: string }>(sql`
    SELECT p.id FROM projects p
     WHERE p.team_id = ${teamId}
       AND EXISTS (SELECT 1 FROM team_members t WHERE t.team_id = p.team_id AND t.user_id = ${userId})
       AND ${viewableBy(userId)}`);
  return res.rows.map((r) => r.id);
}

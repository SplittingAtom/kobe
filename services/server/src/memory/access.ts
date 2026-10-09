import { and, eq, projects, type KobeTx } from "@kobe/db";
import { viewerProjectIds } from "../threads/references.js";

/**
 * Project access seam (D23/D24). Project memory is shared by the project's members, who may read
 * and edit it. The project must exist in the active team (RLS plus an explicit team filter), and
 * the caller must be a member: `viewerProjectIds` is empty until KOBE-161 lands membership, so
 * project docs stay unreachable through the API until then. Personal memory needs no seam.
 */
export async function canAccessProject(
  tx: KobeTx,
  teamId: string,
  userId: string,
  projectId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.teamId, teamId), eq(projects.id, projectId)));
  return row !== undefined && (await viewerProjectIds(tx, userId)).includes(projectId);
}

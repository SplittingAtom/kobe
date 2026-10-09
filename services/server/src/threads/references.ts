import type { KobeTx } from "@kobe/db";
import { loadAccess, memberProjectIds } from "../projects/access.js";

/**
 * Project seams of the thread API (KOBE-57, D23), implemented by `projects/`. Each runs inside the
 * caller's `withTeam` transaction.
 *
 * - `viewerProjectIds`: the active team's projects the viewer is a member of (explicitly, or
 *   implicitly while `members_mode` is `team`); threads shared to those projects are readable.
 * - `canCreateInProject`: the viewer may use the project (member, or team admin) and it is not
 *   archived. Non-members get the same answer as for a missing project.
 *
 * Agent pins (D19) are no longer a seam: `agents/versions.ts` (KOBE-46) resolves them.
 */

export function viewerProjectIds(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<readonly string[]> {
  return memberProjectIds(tx, teamId, userId);
}

export async function canCreateInProject(
  tx: KobeTx,
  viewer: { teamId: string; userId: string },
  projectId: string,
): Promise<boolean> {
  const access = await loadAccess(tx, viewer, projectId);
  return access !== undefined && access.project.archivedAt === null && access.can.use;
}

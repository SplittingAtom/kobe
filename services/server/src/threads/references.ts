import type { KobeTx } from "@kobe/db";

/**
 * Seams to tables that don't exist yet. Each runs inside the caller's `withTeam` transaction, so
 * its eventual implementation reads under the active team's RLS.
 *
 * - Projects (KOBE-57): `viewerProjectIds` returns the active team's projects the viewer is a
 *   member of; threads shared to those projects become readable (D23). Until projects exist it is
 *   empty and no thread can be created in a project.
 *
 * Agent pins (D19) are no longer a seam: `agents/versions.ts` (KOBE-46) resolves them.
 */

export async function viewerProjectIds(_tx: KobeTx, _userId: string): Promise<readonly string[]> {
  return [];
}

export async function canCreateInProject(
  _tx: KobeTx,
  _userId: string,
  _projectId: string,
): Promise<boolean> {
  return false;
}

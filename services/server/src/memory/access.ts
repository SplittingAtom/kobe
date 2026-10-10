import type { KobeTx } from "@kobe/db";
import { loadAccess } from "../projects/access.js";

/**
 * Project access (D23/D24, KOBE-161). Project memory is shared by the project's members, who may
 * read and edit it: explicit members, or any team member while `members_mode` is `team`. A team
 * admin who is not a member has no access (admins manage the project, not its memory). Anyone
 * else, and a missing project, is the same answer (callers reply 404). Personal memory needs no
 * seam.
 */
export async function canAccessProject(
  tx: KobeTx,
  teamId: string,
  userId: string,
  projectId: string,
): Promise<boolean> {
  const access = await loadAccess(tx, { teamId, userId }, projectId);
  return access !== undefined && access.role !== undefined;
}

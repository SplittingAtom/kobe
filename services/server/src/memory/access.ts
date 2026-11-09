import type { KobeTx } from "@kobe/db";
import { loadAccess } from "../projects/access.js";

/**
 * Project memory access (D24, Workspaces PR3/PR6, KOBE-578). Every reader of the project reads its
 * memory (explicit rows, every workspace member while visibility is `workspace`, team admins);
 * writing it (the memory panel, the agent's `remember`) needs `edit` (editor, owner, team admin).
 * A project the caller may not view, and a missing one, are the same answer (callers reply 404).
 * Personal memory needs no seam.
 */
export type ProjectMemoryAccess = "none" | "read" | "write";

export async function projectMemoryAccess(
  tx: KobeTx,
  teamId: string,
  userId: string,
  projectId: string,
): Promise<ProjectMemoryAccess> {
  const access = await loadAccess(tx, { teamId, userId }, projectId);
  if (!access) return "none";
  return access.can.edit ? "write" : "read";
}

/** The caller may read the project's memory (and its files, threads shared to it). */
export async function canAccessProject(
  tx: KobeTx,
  teamId: string,
  userId: string,
  projectId: string,
): Promise<boolean> {
  return (await projectMemoryAccess(tx, teamId, userId, projectId)) !== "none";
}

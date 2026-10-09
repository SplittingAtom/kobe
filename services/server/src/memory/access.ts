import type { KobeTx } from "@kobe/db";
import { viewerProjectIds } from "../threads/references.js";

/**
 * Project access seam (D23/D24). Project memory is shared by the project's members, who may read
 * and edit it. Projects arrive with KOBE-57/160; until then `viewerProjectIds` is empty, so no
 * project doc is reachable through the API. Personal memory needs no seam: it is the caller's own.
 */
export async function canAccessProject(
  tx: KobeTx,
  userId: string,
  projectId: string,
): Promise<boolean> {
  return (await viewerProjectIds(tx, userId)).includes(projectId);
}

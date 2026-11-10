import type { KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";

/**
 * The Files panel's Delete (KOBE-148), shared with Promote to project (KOBE-586, PF3): each live
 * file becomes a server tombstone the sandbox pulls, and one `workspace.file_deleted` row counts
 * them. The caller holds the legal-hold and workspace locks and has checked both.
 */
export async function deleteWorkspaceFiles(
  tx: KobeTx,
  sync: Pick<WorkspaceSync, "deleteServerFile">,
  owner: WorkspaceOwner,
  files: readonly { readonly path: string; readonly size: number }[],
): Promise<void> {
  for (const file of files) await sync.deleteServerFile(tx, owner, file.path);
  await recordAudit(tx, {
    action: "workspace.file_deleted",
    teamId: owner.teamId,
    target: {
      userId: owner.userId,
      files: files.length,
      bytes: files.reduce((sum, f) => sum + f.size, 0),
    },
  });
}

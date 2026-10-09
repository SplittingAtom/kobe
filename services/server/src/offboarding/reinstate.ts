import { SYSTEM_ACTOR, isUnderLegalHold, lockLegalHolds, sql, withTeam } from "@kobe/db";
import { currentAuditContext } from "../audit/context.js";
import { recordAudit } from "../audit/record.js";
import { auditTimeout } from "../retention/locks.js";
import { findTeam } from "./destroy.js";
import type { Departed, OffboardingContext } from "./types.js";

/**
 * A member who returns (re-invited, or reactivated) before or after the 30 days gets a new
 * sandbox (KOBE-25 leaves this to KOBE-28): the offboarded row and its retained volume are
 * dropped (the durable S3 copy stays, so the new sandbox restores the workspace, KOBE-27) and the
 * wake continues as a first start. Under a legal hold the volume must stay (KOBE-17), so the wake
 * is refused until the hold is released. True: the wake may go on.
 */
export async function reinstateReturning(
  ctx: OffboardingContext,
  target: Departed,
): Promise<boolean> {
  const team = await findTeam(ctx, target.teamId);
  if (!team) return false;
  return withTeam(ctx.db, target.teamId, async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
    await lockLegalHolds(tx);
    const current = await tx.execute<{ state: string; pvc: string | null }>(sql`
      SELECT state, pvc FROM sandboxes
       WHERE team_id = ${target.teamId} AND user_id = ${target.userId} FOR UPDATE`);
    const row = current.rows[0];
    if (!row || row.state !== "destroyed") return true;
    if (await isUnderLegalHold(tx, target.teamId, target.userId)) return false;
    if (row.pvc) {
      const provider = ctx.provider();
      if (!provider) return false;
      await provider.deleteVolume(team, row.pvc);
    }
    await tx.execute(sql`
      DELETE FROM sandboxes WHERE team_id = ${target.teamId} AND user_id = ${target.userId}`);
    if (row.pvc) {
      await auditTimeout(tx);
      await recordAudit(tx, {
        action: "sandbox.volume_deleted",
        actor: currentAuditContext()?.actor ?? SYSTEM_ACTOR,
        teamId: target.teamId,
        // The member is back: the old volume goes, the S3 copy (files, blobs) stays.
        target: { userId: target.userId, volumeDeleted: true, files: 0, blobs: 0, bytes: 0 },
      });
    }
    return true;
  });
}

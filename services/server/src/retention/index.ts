import { and, eq, isNull, teamMembers, users, withTeam, type KobeDb } from "@kobe/db";
import { deleteReleasedBlobs, type BlobDeletionCounts, type BlobStore } from "./blobs.js";
import { blobRecorder, purgeRecorder } from "./job.js";
import { purgeThreads, type PurgeOutcome } from "./purge.js";

export { deletableKey, deleteReleasedBlobs, type BlobStore } from "./blobs.js";
export { compactRunEvents } from "./compaction.js";
export { deleteForever } from "./delete-forever.js";
export { exportResponseBody, recordExport } from "./export.js";
export { RetentionJob, runRetentionPass, type PassResult } from "./job.js";
export * from "./periods.js";
export { purgeThreads, type PurgeCounts, type PurgeOutcome, type PurgeSelection } from "./purge.js";
export { readMaximum, readRetention, setMaximum, setTeamPeriod } from "./settings.js";

export class StillAMemberError extends Error {
  constructor() {
    super("refusing to purge the threads of a current team member");
    this.name = "StillAMemberError";
  }
}

export interface DepartedPurgeResult {
  readonly threads: PurgeOutcome;
  readonly blobs: BlobDeletionCounts;
}

/**
 * Offboarding (KOBE-28, spec D12/D18): hard-deletes every thread `userId` owns in `teamId` — Trash
 * included — with their entries, runs, run events and thread-owned blobs, then deletes the
 * released objects. Call it once the 30-day retention after the member left (or was deactivated)
 * is over. Legal-hold aware (held threads are skipped, `status: "held"` when a guard refused),
 * batched in short transactions, audited as `retention.purged` (reason `offboarding`, `userId`,
 * counts only) and `retention.blobs_deleted`. Refuses (`StillAMemberError`) while the user is an
 * active member of the team (a deactivated member's threads may go). Workspace volumes and the workspace S3 copy are KOBE-28's own step.
 */
export async function purgeDepartedMember(
  db: KobeDb,
  input: { readonly teamId: string; readonly userId: string },
  blobs?: BlobStore,
): Promise<DepartedPurgeResult> {
  const { teamId, userId } = input;
  const member = await withTeam(db, teamId, async (tx) =>
    tx
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, userId),
          isNull(users.deactivatedAt),
        ),
      ),
  );
  if (member.length > 0) throw new StillAMemberError();
  const threads = await purgeThreads(
    db,
    teamId,
    { kind: "user", userId },
    purgeRecorder(teamId, "offboarding", userId),
  );
  const released = blobs
    ? await deleteReleasedBlobs(db, teamId, blobs, blobRecorder(teamId))
    : { blobs: 0, kept: 0 };
  return { threads, blobs: released };
}

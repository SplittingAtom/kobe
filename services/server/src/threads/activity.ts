import { and, eq, sql, threads, type KobeTx } from "@kobe/db";
import type { ThreadActivityList } from "./schemas.js";

/** Most threads one answer lists (a member rarely has more than a few runs at once). */
export const MAX_ACTIVE_THREADS = 200;

/**
 * `GET /v1/threads/activity` (KOBE-301): the caller's own live threads with a run going, and
 * whether an approval waits for them there (pending, unexpired, on their run: only the run's user
 * decides, KOBE-37). The rail's dots and the hidden tab's title poll this instead of the lists.
 * One query on `threads_owner_activity_idx`, `team_id` stated (break-glass policy), called inside
 * `withTeam`. The subquery names `threads.*` in full: drizzle renders a bare column here, which
 * would bind to `approvals`. A thread waiting for an approval is `running` too (`waiting_approval` holds it).
 */
export async function listThreadActivity(
  tx: KobeTx,
  viewer: { readonly teamId: string; readonly userId: string },
): Promise<ThreadActivityList> {
  const rows = await tx
    .select({
      id: threads.id,
      approval: sql<boolean>`EXISTS (SELECT 1 FROM approvals a
        WHERE a.team_id = threads.team_id AND a.thread_id = threads.id
          AND a.user_id = ${viewer.userId} AND a.status = 'pending' AND a.expires_at > now())`,
    })
    .from(threads)
    .where(
      and(
        eq(threads.teamId, viewer.teamId),
        eq(threads.ownerUserId, viewer.userId),
        sql`${threads.deletedAt} IS NULL`,
        eq(threads.isTest, false),
        // A skill eval's thread (KOBE-325) is no chat of the member's: no rail dot either.
        eq(threads.skillEval, false),
        eq(threads.status, "running"),
      ),
    )
    .orderBy(threads.id)
    .limit(MAX_ACTIVE_THREADS);
  return {
    threads: rows.map((r) => ({
      thread_id: r.id,
      activity: r.approval ? ("approval" as const) : ("running" as const),
    })),
  };
}

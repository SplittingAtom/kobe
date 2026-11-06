import {
  and,
  approvals,
  asc,
  count,
  eq,
  runs,
  sql,
  threadBranchLabels,
  threadEntries,
  type KobeTx,
} from "@kobe/db";
import { BRANCH_LABELS_MAX, type ThreadBranchesResponse } from "@kobe/protocol";
import { findThread, lockForChange, type ThreadError, type Viewer } from "./repository.js";

/**
 * The conversation tree's server side (KOBE-543, docs/specs/conversation-tree.md CT2, CT9):
 * branch labels and the runs that wrote a remember-rule. Labels are the owner's personal
 * organisation: never model context, never in Pi's session file, not audited, never activity.
 */

export type LabelError =
  | Extract<
      ThreadError,
      "thread_not_found" | "read_only" | "thread_in_trash" | "test_thread" | "entry_not_found"
    >
  | "label_limit";

export type BranchesResult =
  { ok: true; branches: ThreadBranchesResponse } | { ok: false; error: LabelError };

/** The thread's labels and remembered-rule runs; the thread is already known readable. */
async function readBranchesOf(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<ThreadBranchesResponse> {
  const labels = await tx
    .select({ entry_id: threadBranchLabels.entryId, label: threadBranchLabels.label })
    .from(threadBranchLabels)
    .where(and(eq(threadBranchLabels.teamId, teamId), eq(threadBranchLabels.threadId, threadId)))
    .orderBy(asc(threadBranchLabels.entryId))
    .limit(BRANCH_LABELS_MAX);
  // A run maps to its node by its prompt entry (runs.user_entry_id); a run whose prompt was never
  // committed has none and no node to badge.
  const remembered = await tx
    .selectDistinct({ userEntryId: runs.userEntryId })
    .from(approvals)
    .innerJoin(runs, and(eq(runs.teamId, approvals.teamId), eq(runs.id, approvals.runId)))
    .where(
      and(
        eq(approvals.teamId, teamId),
        eq(approvals.threadId, threadId),
        eq(approvals.remembered, true),
        eq(runs.teamId, teamId),
        eq(runs.threadId, threadId),
        sql`${runs.userEntryId} IS NOT NULL`,
      ),
    );
  return {
    labels,
    runs: remembered.flatMap((r) =>
      r.userEntryId === null ? [] : [{ user_entry_id: r.userEntryId, remembered_rule: true }],
    ),
  };
}

/** `GET /v1/threads/{id}/branches` (CT2): for whoever may read the thread; null = 404. */
export async function readBranches(
  tx: KobeTx,
  viewer: Viewer,
  threadId: string,
): Promise<ThreadBranchesResponse | null> {
  if (!(await findThread(tx, viewer, threadId))) return null;
  return readBranchesOf(tx, viewer.teamId, threadId);
}

/**
 * `PUT /v1/threads/{id}/labels/{entryId}` (CT9): sets (or, with null, removes) the label on one
 * entry of the thread. Owner only, under the thread's row lock (which also serializes the
 * {@link BRANCH_LABELS_MAX} check); refused in Trash and on builder test, Workbench and eval
 * threads (CT19). Idempotent; touches neither `last_activity_at` nor the audit log.
 */
export async function setLabel(
  tx: KobeTx,
  viewer: Viewer,
  threadId: string,
  entryId: string,
  label: string | null,
): Promise<BranchesResult> {
  const locked = await lockForChange(tx, viewer, threadId);
  if (!locked.ok) {
    return { ok: false, error: locked.error === "read_only" ? "read_only" : "thread_not_found" };
  }
  const thread = locked.thread;
  if (thread.deletedAt) return { ok: false, error: "thread_in_trash" };
  if (thread.isTest || thread.skillTest === true || thread.skillEval === true) {
    return { ok: false, error: "test_thread" };
  }
  const [entry] = await tx
    .select({ entryId: threadEntries.entryId })
    .from(threadEntries)
    .where(
      and(
        eq(threadEntries.teamId, viewer.teamId),
        eq(threadEntries.threadId, threadId),
        eq(threadEntries.entryId, entryId),
      ),
    );
  if (!entry) return { ok: false, error: "entry_not_found" };
  const key = and(
    eq(threadBranchLabels.teamId, viewer.teamId),
    eq(threadBranchLabels.threadId, threadId),
    eq(threadBranchLabels.entryId, entryId),
  );
  if (label === null) {
    await tx.delete(threadBranchLabels).where(key);
  } else {
    const [existing] = await tx
      .select({ label: threadBranchLabels.label })
      .from(threadBranchLabels)
      .where(key);
    if (!existing) {
      const [held] = await tx
        .select({ n: count() })
        .from(threadBranchLabels)
        .where(
          and(
            eq(threadBranchLabels.teamId, viewer.teamId),
            eq(threadBranchLabels.threadId, threadId),
          ),
        );
      if ((held?.n ?? 0) >= BRANCH_LABELS_MAX) return { ok: false, error: "label_limit" };
      await tx.insert(threadBranchLabels).values({
        teamId: viewer.teamId,
        threadId,
        entryId,
        label,
        createdBy: viewer.userId,
      });
    } else if (existing.label !== label) {
      await tx
        .update(threadBranchLabels)
        .set({ label, updatedAt: sql`now()` })
        .where(key);
    }
  }
  return { ok: true, branches: await readBranchesOf(tx, viewer.teamId, threadId) };
}

/**
 * A fork's labels (CT9, Q12): the source's labels on the copied path, same entry ids, written in
 * the fork's transaction after its entries; the fork's owner becomes their author.
 */
export async function copyLabels(
  tx: KobeTx,
  viewer: Viewer,
  sourceThreadId: string,
  forkThreadId: string,
  entryIds: readonly string[],
): Promise<number> {
  if (entryIds.length === 0) return 0;
  // At most BRANCH_LABELS_MAX rows: read them all and keep those on the path.
  const onPath = new Set(entryIds);
  const labels = (
    await tx
      .select({ entryId: threadBranchLabels.entryId, label: threadBranchLabels.label })
      .from(threadBranchLabels)
      .where(
        and(
          eq(threadBranchLabels.teamId, viewer.teamId),
          eq(threadBranchLabels.threadId, sourceThreadId),
        ),
      )
  ).filter((l) => onPath.has(l.entryId));
  if (labels.length === 0) return 0;
  await tx.insert(threadBranchLabels).values(
    labels.map((l) => ({
      teamId: viewer.teamId,
      threadId: forkThreadId,
      entryId: l.entryId,
      label: l.label,
      createdBy: viewer.userId,
    })),
  );
  return labels.length;
}

import { threadBranchSummaryResultShape, type PiGetEntriesData } from "@kobe/protocol";
import { sql, type KobeTx } from "@kobe/db";
import { z } from "zod";
import { appendRunEventsInTx } from "../event-stream/append.js";
import { leafMovedEvents, mirrorEntriesInTx } from "./entries.js";
import { runStillOpen } from "./run-state.js";

/** The sandbox's `{entry_id, parent_id}` (KOBE-548); untrusted until the mirror confirms it. */
export interface BranchSummaryReported {
  readonly entry_id: string;
  readonly parent_id: string;
}

const reportedSchema = z.strictObject(threadBranchSummaryResultShape);

export function parseBranchSummaryResult(data: unknown): BranchSummaryReported | undefined {
  const parsed = reportedSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

export interface BranchSummaryMirror {
  readonly teamId: string;
  readonly threadId: string;
  readonly runId: string;
  /** Pi's new entries (undefined: the sync failed). */
  readonly entries: PiGetEntriesData | undefined;
  readonly reported: BranchSummaryReported;
  /** The node the member chose (`thread.branch_summary.to_entry_id`). */
  readonly toEntryId: string;
  readonly maxEntries: number;
}

/**
 * In the run's end transaction (KOBE-548, CT11, CT13): mirror Pi's new entries without moving the
 * leaf, then make the reported entry the thread's leaf, but only if this mirror stored it as a
 * `branch_summary` under the reported parent, and that parent is `to_entry_id` or, for a user
 * message target, its parent (Pi's placement). The run's stream hears the leaf move
 * (`leafMovedEvents`) while the run is still open (`runStillOpen`); a run already closed (Stop or
 * the sweep racing it) still gets the leaf, since Pi's session is on the summary, and other tabs see
 * it on their focus re-read. `ok: false` leaves the leaf; the caller fails the run.
 */
export async function mirrorBranchSummaryInTx(
  tx: KobeTx,
  m: BranchSummaryMirror,
): Promise<{ readonly ok: boolean; readonly capped: boolean }> {
  const { teamId, threadId, runId, reported } = m;
  const before = await tx.execute<{ leaf_entry_id: string | null }>(sql`
    SELECT leaf_entry_id FROM threads
     WHERE team_id = ${teamId} AND id = ${threadId} FOR NO KEY UPDATE`);
  const leafBefore = before.rows[0]?.leaf_entry_id ?? null;
  if (m.entries === undefined) return { ok: false, capped: false };
  const mirrored = await mirrorEntriesInTx(tx, teamId, threadId, m.entries, m.maxEntries, {
    moveLeaf: false,
  });
  const capped = mirrored.capped;
  const stored = mirrored.inserted.find((e) => e.id === reported.entry_id);
  if (stored?.type !== "branch_summary" || stored.parentId !== reported.parent_id) {
    return { ok: false, capped };
  }
  const target = await tx.execute<{ parent_id: string | null }>(sql`
    SELECT parent_id FROM thread_entries
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND entry_id = ${m.toEntryId}`);
  const placed = [m.toEntryId, target.rows[0]?.parent_id ?? null];
  if (!placed.includes(reported.parent_id)) return { ok: false, capped };
  await tx.execute(sql`
    UPDATE threads SET leaf_entry_id = ${reported.entry_id}, last_activity_at = now()
     WHERE team_id = ${teamId} AND id = ${threadId}`);
  const moved = leafMovedEvents(
    threadId,
    reported.entry_id === leafBefore ? null : reported.entry_id,
  );
  if (moved.length > 0 && (await runStillOpen(tx, teamId, runId))) {
    await appendRunEventsInTx(tx, teamId, runId, moved);
  }
  return { ok: true, capped };
}

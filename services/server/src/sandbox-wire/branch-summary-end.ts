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
  readonly maxEntries: number;
}

/**
 * In the run's end transaction (KOBE-548, CT11, CT13): mirror Pi's new entries, then make the
 * reported entry the thread's leaf, but only if it is now a mirrored `branch_summary` of this thread
 * under the reported parent. The run's stream hears the leaf move (`leafMovedEvents`) while the run
 * is still open (`runStillOpen`), as for a compaction. `ok: false` leaves the leaf as the mirror
 * left it; the caller fails the run.
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
  const capped =
    m.entries === undefined
      ? false
      : (await mirrorEntriesInTx(tx, teamId, threadId, m.entries, m.maxEntries)).capped;
  const entry = await tx.execute<{ type: string; parent_id: string | null }>(sql`
    SELECT type, parent_id FROM thread_entries
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND entry_id = ${reported.entry_id}`);
  const row = entry.rows[0];
  if (row?.type !== "branch_summary" || row.parent_id !== reported.parent_id) {
    return { ok: false, capped };
  }
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

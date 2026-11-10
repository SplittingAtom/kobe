/**
 * Blocked-egress cards that outlive their run (KOBE-605). The live stream only carries the run
 * being followed (`live.ts`), so once the next run starts, or after a reload, an answer's
 * `egress.blocked` notices would be gone. `GET /v1/threads/{id}/egress-blocked` reads them back
 * from the run's stored events; each answer shows its run's (by the run's prompt entry, as the
 * answers' footers find their run). The run on the live stream is left to the run notices, so a
 * card is never shown twice; closing one (KOBE-468) uses the same id either way.
 */
import {
  threadEgressBlockedResponseSchema,
  type KobeEvent,
  type ThreadEgressBlockedResponse,
} from "@kobe/protocol";
import { MAX_ITEMS } from "./live";
import { readWire } from "./wire-read";

export type BlockedNotice = KobeEvent<"egress.blocked">;

/** One read, validated as sent (wire casing). Never throws: null on failure. */
export function readThreadEgressBlocked(
  threadId: string,
  teamId: string,
  fetchFn: typeof fetch = fetch,
): Promise<ThreadEgressBlockedResponse | null> {
  const route = `/v1/threads/${encodeURIComponent(threadId)}/egress-blocked`;
  return readWire(route, threadEgressBlockedResponseSchema, teamId, fetchFn);
}

/**
 * The read's notices by the prompt entry of the run that hit them, without `liveRunId`'s (the run
 * notices show those) and rows with no prompt entry; at most {@link MAX_ITEMS} per run, one per
 * domain, as the live reducer keeps them.
 */
export function blockedByPrompt(
  read: ThreadEgressBlockedResponse | null,
  liveRunId: string | undefined,
): ReadonlyMap<string, readonly BlockedNotice[]> {
  const byPrompt = new Map<string, BlockedNotice[]>();
  for (const row of read?.blocked ?? []) {
    if (row.user_entry_id === null || row.run_id === liveRunId) continue;
    const list = byPrompt.get(row.user_entry_id) ?? [];
    const dup = list.some(
      (n) => n.run_id === row.run_id && n.payload.domain === row.payload.domain,
    );
    if (dup) continue;
    const notice: BlockedNotice = {
      type: "egress.blocked",
      run_id: row.run_id,
      seq: row.seq,
      ts: row.ts,
      payload: row.payload,
    };
    const next = [...list, notice];
    byPrompt.set(row.user_entry_id, next.length > MAX_ITEMS ? next.slice(-MAX_ITEMS) : next);
  }
  return byPrompt;
}

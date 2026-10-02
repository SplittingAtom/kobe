import {
  jsonValueSchema,
  parseEventPayload,
  piGetEntriesDataSchema,
  type PiGetEntriesData,
  type PiSessionEntry,
} from "@kobe/protocol";
import { sql, threadEntries, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import type { NewRunEvent } from "../event-stream/append.js";
import { ENTRY_EVENT_PAYLOAD_MAX_BYTES, RESTORE_PART_MAX_BYTES } from "./constants.js";

/**
 * Mirroring Pi session entries into `thread_entries` (D15). Entries come from the sandbox, so they
 * are untrusted: the `get_entries` data must pass `piGetEntriesDataSchema`, an entry id already
 * mirrored is never overwritten, a parent must already be mirrored (or come earlier in the same
 * batch), and the leaf must be an entry of this thread. Nothing in an entry is ever used for an
 * authorization decision; it is displayed and replayed to Pi only.
 */

export interface MirrorResult {
  readonly inserted: readonly PiSessionEntry[];
  /** Entries skipped because their parent is unknown (a broken or hostile tree). */
  readonly orphans: number;
  /** Entries whose id already exists (normal for overlapping syncs). */
  readonly existing: number;
  readonly leafId: string | null;
}

export function parseGetEntries(data: unknown): PiGetEntriesData | undefined {
  const parsed = piGetEntriesDataSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

/** The last mirrored entry of a thread (the `get_entries since` cursor), by append order. */
export async function lastMirroredEntryId(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<string | undefined> {
  const res = await tx.execute<{ entry_id: string }>(sql`
    SELECT entry_id FROM thread_entries
     WHERE team_id = ${teamId} AND thread_id = ${threadId}
     ORDER BY seq DESC LIMIT 1`);
  return res.rows[0]?.entry_id;
}

const CHUNK = 100;

/**
 * Inserts the new entries of `data` in order and moves the thread's leaf. Locks the thread row
 * first (KOBE-29 lock order: thread before run). Must run inside the thread's team transaction.
 */
export async function mirrorEntriesInTx(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  data: PiGetEntriesData,
): Promise<MirrorResult> {
  await tx.execute(sql`
    SELECT 1 FROM threads WHERE team_id = ${teamId} AND id = ${threadId} FOR NO KEY UPDATE`);
  const ids = new Set<string>();
  for (const e of data.entries) {
    ids.add(e.id);
    if (e.parentId !== null) ids.add(e.parentId);
  }
  if (data.leafId !== null) ids.add(data.leafId);
  const known = new Set<string>();
  const existingRows =
    ids.size === 0
      ? []
      : (
          await tx.execute<{ entry_id: string }>(sql`
            SELECT entry_id FROM thread_entries
             WHERE team_id = ${teamId} AND thread_id = ${threadId}
               AND entry_id IN (${sql.join(
                 [...ids].map((id) => sql`${id}`),
                 sql`, `,
               )})`)
        ).rows;
  for (const row of existingRows) known.add(row.entry_id);

  const inserted: PiSessionEntry[] = [];
  let orphans = 0;
  let existing = 0;
  for (const entry of data.entries) {
    if (known.has(entry.id)) {
      existing += 1;
      continue;
    }
    if (entry.parentId !== null && !known.has(entry.parentId)) {
      orphans += 1;
      continue;
    }
    known.add(entry.id);
    inserted.push(entry);
  }
  for (let i = 0; i < inserted.length; i += CHUNK) {
    await tx.insert(threadEntries).values(
      inserted.slice(i, i + CHUNK).map((e) => ({
        teamId,
        threadId,
        entryId: e.id,
        parentId: e.parentId,
        type: e.type,
        payload: e as Record<string, unknown>,
      })),
    );
  }
  const leafId = data.leafId !== null && known.has(data.leafId) ? data.leafId : null;
  if (leafId !== null || inserted.length > 0) {
    await tx.execute(sql`
      UPDATE threads
         SET leaf_entry_id = COALESCE(${leafId}, leaf_entry_id), last_activity_at = now()
       WHERE team_id = ${teamId} AND id = ${threadId}`);
  }
  return { inserted, orphans, existing, leafId };
}

function isAssistantMessage(entry: PiSessionEntry): boolean {
  const message = (entry as { message?: { role?: unknown } }).message;
  return entry.type === "message" && message?.role === "assistant";
}

/**
 * `entry.committed` events for newly mirrored entries. Assistant message entries are bound, in
 * order, to the stream-local message ids their deltas used (`takeMessageId`).
 */
export function entryCommittedEvents(
  entries: readonly PiSessionEntry[],
  takeMessageId: () => string | undefined,
): NewRunEvent[] {
  const out: NewRunEvent[] = [];
  for (const entry of entries) {
    const messageId = isAssistantMessage(entry) ? takeMessageId() : undefined;
    const json = JSON.stringify(entry);
    const small =
      Buffer.byteLength(json, "utf8") <= ENTRY_EVENT_PAYLOAD_MAX_BYTES &&
      jsonValueSchema.safeParse(entry).success;
    try {
      out.push({
        type: "entry.committed",
        payload: parseEventPayload("entry.committed", {
          entry_id: entry.id,
          parent_id: entry.parentId,
          entry_type: entry.type,
          ...(messageId === undefined ? {} : { message_id: messageId }),
          ...(small ? { payload: entry } : {}),
        }),
      });
    } catch {
      // An entry id the event schema refuses (control characters) is stored but not streamed.
    }
  }
  return out;
}

/** Rows read per page while restoring (each row is at most one 4 MiB frame's worth). */
const RESTORE_PAGE_ROWS = 16;

/**
 * The thread's entries in append order as `session.restore` parts of bounded size (D13, D15),
 * read page by page (keyset on `seq`, one short transaction each), so a long thread is never held
 * in memory at once. The last part has `final: true` (an empty thread yields one empty final part).
 */
export async function* restoreParts(
  db: KobeDb,
  teamId: string,
  threadId: string,
): AsyncGenerator<{ entries: PiSessionEntry[]; final: boolean }> {
  let after = 0;
  let part: PiSessionEntry[] = [];
  let bytes = 0;
  for (;;) {
    const rows = await withTeam(db, teamId, async (tx) => {
      const res = await tx.execute<{ seq: number; payload: PiSessionEntry }>(sql`
        SELECT seq, payload FROM thread_entries
         WHERE team_id = ${teamId} AND thread_id = ${threadId} AND seq > ${after}
         ORDER BY seq LIMIT ${RESTORE_PAGE_ROWS}`);
      return res.rows;
    });
    for (const { seq, payload } of rows) {
      const size = Buffer.byteLength(JSON.stringify(payload), "utf8");
      if (part.length > 0 && bytes + size > RESTORE_PART_MAX_BYTES) {
        yield { entries: part, final: false };
        part = [];
        bytes = 0;
      }
      part.push(payload);
      bytes += size;
      after = seq;
    }
    if (rows.length < RESTORE_PAGE_ROWS) break;
  }
  yield { entries: part, final: true };
}

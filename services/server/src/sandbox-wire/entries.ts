import {
  jsonValueSchema,
  parseEventPayload,
  piGetEntriesDataSchema,
  type PiGetEntriesData,
  type PiSessionEntry,
} from "@kobe/protocol";
import { sql, threadEntries, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import type { NewRunEvent } from "../event-stream/append.js";
import { SKIPPED_ENTRY_TYPE } from "../policy/skipped-summary.js";
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
  /** Entries skipped because their id is one only the server writes (`ks-`, `ku-`): hostile. */
  readonly reserved: number;
  /** Entries whose id already exists (normal for overlapping syncs). */
  readonly existing: number;
  /** The thread reached `maxEntries`: later entries were not stored. */
  readonly capped: boolean;
  /** UTF-8 bytes of the inserted payloads. */
  readonly bytes: number;
  readonly leafId: string | null;
}

/**
 * Entry ids of prompts the server keeps for runs that ended before Pi ever received them
 * (KOBE-290, `runs/run-prompt.ts`). Pi's ids are short hex, so these never collide; like the
 * skipped-actions note they are not in Pi's session.
 */
export const UNSENT_PROMPT_PREFIX = "ku-";

export function unsentPromptEntryId(runId: string): string {
  return `${UNSENT_PROMPT_PREFIX}${runId.replaceAll("-", "").slice(0, 24)}`;
}

export function isUnsentPromptEntryId(entryId: string): boolean {
  return entryId.startsWith(UNSENT_PROMPT_PREFIX);
}

/** Ids only the server writes (the skipped-actions note `ks-`, an unsent prompt `ku-`). */
export function isServerEntryId(entryId: string): boolean {
  return entryId.startsWith("ks-") || isUnsentPromptEntryId(entryId);
}

/**
 * Rows of `thread_entries` that Pi's session holds: not the server's own entries (a scheduled
 * run's skipped-actions note, an unsent prompt). They are never the sync cursor, never restored
 * into Pi, and never where Pi continues from.
 */
export const piSessionEntrySql = sql`NOT (type = 'custom_message' AND payload ->> 'customType' = ${SKIPPED_ENTRY_TYPE})
       AND entry_id NOT LIKE ${`${UNSENT_PROMPT_PREFIX}%`}`;

export function parseGetEntries(data: unknown): PiGetEntriesData | undefined {
  const parsed = piGetEntriesDataSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The last mirrored entry of a thread (the `get_entries since` cursor), by append order. Entries
 * the server wrote itself (the scheduled run's skipped-actions report, an unsent prompt) are not
 * in Pi's session, so they are never the cursor: Pi would not know them.
 */
export async function lastMirroredEntryId(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<string | undefined> {
  const res = await tx.execute<{ entry_id: string }>(sql`
    SELECT entry_id FROM thread_entries
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND ${piSessionEntrySql}
     ORDER BY seq DESC LIMIT 1`);
  return res.rows[0]?.entry_id;
}

/**
 * Whether the thread has a user or assistant message in Postgres (KOBE-258). Without one there is
 * nothing to restore into Pi: a Pi that no longer knows the mirrored cursor is adopted instead.
 */
export async function threadHasConversation(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<boolean> {
  const res = await tx.execute(sql`
    SELECT 1 FROM thread_entries
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND type = 'message'
       AND payload -> 'message' ->> 'role' IN ('user', 'assistant') AND ${piSessionEntrySql}
     LIMIT 1`);
  return (res.rowCount ?? 0) > 0;
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
  maxEntries: number,
): Promise<MirrorResult> {
  const thread = await tx.execute<{ last_entry_seq: number }>(sql`
    SELECT last_entry_seq FROM threads
     WHERE team_id = ${teamId} AND id = ${threadId} FOR NO KEY UPDATE`);
  let room = maxEntries - (thread.rows[0]?.last_entry_seq ?? maxEntries);
  let capped = false;
  let bytes = 0;
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
  let reserved = 0;
  for (const entry of data.entries) {
    if (isServerEntryId(entry.id)) {
      reserved += 1;
      continue;
    }
    if (known.has(entry.id)) {
      existing += 1;
      continue;
    }
    if (entry.parentId !== null && !known.has(entry.parentId)) {
      orphans += 1;
      continue;
    }
    if (room <= 0) {
      capped = true;
      break;
    }
    room -= 1;
    known.add(entry.id);
    inserted.push(entry);
    bytes += Buffer.byteLength(JSON.stringify(entry), "utf8");
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
  const leafId =
    data.leafId !== null && known.has(data.leafId) && !isServerEntryId(data.leafId)
      ? data.leafId
      : null;
  if (leafId !== null || inserted.length > 0) {
    await tx.execute(sql`
      UPDATE threads
         SET leaf_entry_id = COALESCE(${leafId}, leaf_entry_id), last_activity_at = now()
       WHERE team_id = ${teamId} AND id = ${threadId}`);
  }
  return { inserted, orphans, reserved, existing, leafId, capped, bytes };
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
 * in memory at once. Server-written entries (the skipped-actions report, unsent prompts) are left out: Pi never
 * had them, and as the last entry one would become the session's resume point. The last part has `final: true` (an empty thread yields one empty final part).
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
           AND ${piSessionEntrySql}
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

import type { PiGetEntriesData, PiSessionEntry } from "@kobe/protocol";
import { sql, threadEntries, type KobeTx } from "@kobe/db";
import type { NewRunEvent } from "../event-stream/append.js";
import { WIRE_DEFAULTS } from "../sandbox-wire/constants.js";
import {
  entryCommittedEvents,
  isUnsentPromptEntryId,
  mirrorEntriesInTx,
  unsentPromptEntryId,
} from "../sandbox-wire/entries.js";

/**
 * The prompt of a run that ends before Pi's first `turn_end` (KOBE-290). Pi's entries are
 * mirrored when Pi announces the prompt (`message_end`, translate.ts) and at every turn end, but a
 * run can end first: Stop, a refused or timed-out start, a budget stop. The member's message must
 * still be in the conversation after a reload, once, where Pi has it:
 *
 * - Pi has the prompt: its own entry (Pi's id, parent and branch), from Pi's entries since the
 *   sync cursor, cut after the first user message: nothing else of an ended run is accepted.
 * - Pi never received it (no sandbox ever leased the run, or Pi's entries show no prompt after a
 *   refused start): the server writes it, Pi-shaped, under the run's branch point, with an id Pi
 *   can't have ({@link unsentPromptEntryId}). Pi doesn't know it, so it is never the sync cursor,
 *   never restored, and never where Pi continues from ({@link piBranchPoint}).
 * - Unknown (a sandbox holds the run but its entries can't be read): nothing is written. Pi's
 *   entry comes back with the thread's next sync, never a second copy.
 */
export type PromptSource =
  | { readonly kind: "pi"; readonly entries: PiGetEntriesData }
  | { readonly kind: "never_reached_pi" };

/** Whether the run's prompt is where the thread's leaf should go (`if_latest`: no later run). */
export type LeafMove = "always" | "if_latest";

/**
 * Records the Pi entry id of the run's prompt once the wire mirrored it (`runs.user_entry_id`):
 * the first user message entry committed during the run. Best effort; never overwrites. Returns
 * the bound id (or the one already set).
 */
export async function bindUserEntry(
  tx: KobeTx,
  teamId: string,
  runId: string,
): Promise<string | null> {
  await tx.execute(sql`
    UPDATE runs r SET user_entry_id = (
      SELECT e.payload ->> 'entry_id'
        FROM run_events e
        JOIN thread_entries te
          ON te.team_id = e.team_id AND te.thread_id = r.thread_id
         AND te.entry_id = e.payload ->> 'entry_id'
       WHERE e.team_id = ${teamId} AND e.run_id = ${runId} AND e.type = 'entry.committed'
         AND te.type = 'message' AND te.payload -> 'message' ->> 'role' = 'user'
       ORDER BY e.seq LIMIT 1)
     WHERE r.team_id = ${teamId} AND r.id = ${runId} AND r.user_entry_id IS NULL`);
  const res = await tx.execute<{ user_entry_id: string | null }>(sql`
    SELECT user_entry_id FROM runs WHERE team_id = ${teamId} AND id = ${runId}`);
  return res.rows[0]?.user_entry_id ?? null;
}

function isUserMessage(entry: PiSessionEntry): boolean {
  const message = (entry as { message?: { role?: unknown } }).message;
  return entry.type === "message" && message?.role === "user";
}

/** The sandbox agent's branch marker (`kobe.branch`, written before a run's prompt reaches Pi). */
function isBranchMarkerOf(entry: PiSessionEntry, runId: string): boolean {
  const e = entry as { customType?: unknown; data?: { run_id?: unknown } };
  return entry.type === "custom" && e.customType === "kobe.branch" && e.data?.run_id === runId;
}

/**
 * Pi's new entries up to and including the run's prompt: the first user message after the run's
 * branch marker, or (no marker: the thread's first run, or one continuing from Pi's leaf) the
 * first user message. Undefined when Pi has none.
 */
export function promptPrefix(
  entries: readonly PiSessionEntry[],
  runId: string,
): PiSessionEntry[] | undefined {
  const from = entries.findIndex((e) => isBranchMarkerOf(e, runId));
  const at = entries.findIndex((e, i) => i > from && isUserMessage(e));
  return at < 0 ? undefined : entries.slice(0, at + 1);
}

/** The source for a run whose entries were read: Pi's prompt if it has one, else none reached Pi. */
export function promptSourceOf(entries: PiGetEntriesData, runId: string): PromptSource {
  return promptPrefix(entries.entries, runId) === undefined
    ? { kind: "never_reached_pi" }
    : { kind: "pi", entries };
}

type PromptRun = {
  readonly thread_id: string;
  readonly kind: string;
  readonly input: string;
  readonly parent_entry_id: string | null;
  readonly started_at: Date | string | null;
};

async function lockPromptRun(
  tx: KobeTx,
  teamId: string,
  runId: string,
): Promise<PromptRun | undefined> {
  const head = await tx.execute<{ thread_id: string }>(sql`
    SELECT thread_id FROM runs WHERE team_id = ${teamId} AND id = ${runId}`);
  const threadId = head.rows[0]?.thread_id;
  if (threadId === undefined) return undefined;
  // KOBE-29 lock order: thread before run (no-ops when the end transaction holds both already).
  await tx.execute(sql`
    SELECT 1 FROM threads WHERE team_id = ${teamId} AND id = ${threadId} FOR NO KEY UPDATE`);
  const run = await tx.execute<PromptRun>(sql`
    SELECT thread_id, kind, input, parent_entry_id, started_at FROM runs
     WHERE team_id = ${teamId} AND id = ${runId} FOR NO KEY UPDATE`);
  return run.rows[0];
}

/** No run of the thread started after this one: the conversation has not moved on. */
async function isLatestRun(tx: KobeTx, teamId: string, runId: string, run: PromptRun) {
  if (run.started_at === null) return true;
  const later = await tx.execute(sql`
    SELECT 1 FROM runs
     WHERE team_id = ${teamId} AND thread_id = ${run.thread_id} AND id <> ${runId}
       AND started_at > ${run.started_at}
     LIMIT 1`);
  return later.rows.length === 0;
}

async function setUserEntry(tx: KobeTx, teamId: string, runId: string, entryId: string) {
  await tx.execute(sql`
    UPDATE runs SET user_entry_id = ${entryId}
     WHERE team_id = ${teamId} AND id = ${runId} AND user_entry_id IS NULL`);
}

async function mirrorPiPrompt(
  tx: KobeTx,
  teamId: string,
  runId: string,
  run: PromptRun,
  entries: PiGetEntriesData,
  moveLeaf: boolean,
  maxEntries: number,
): Promise<NewRunEvent[]> {
  const prefix = promptPrefix(entries.entries, runId);
  const prompt = prefix?.at(-1);
  if (prefix === undefined || prompt === undefined) return [];
  const mirrored = await mirrorEntriesInTx(
    tx,
    teamId,
    run.thread_id,
    { entries: prefix, leafId: moveLeaf ? prompt.id : null },
    maxEntries,
  );
  const stored = await tx.execute(sql`
    SELECT 1 FROM thread_entries
     WHERE team_id = ${teamId} AND thread_id = ${run.thread_id} AND entry_id = ${prompt.id}`);
  if (stored.rows.length > 0) await setUserEntry(tx, teamId, runId, prompt.id);
  return entryCommittedEvents(mirrored.inserted, () => undefined);
}

async function writeUnsentPrompt(
  tx: KobeTx,
  teamId: string,
  runId: string,
  run: PromptRun,
  moveLeaf: boolean,
): Promise<NewRunEvent[]> {
  const entryId = unsentPromptEntryId(runId);
  const parent =
    run.parent_entry_id === null
      ? null
      : (
            await tx.execute(sql`
            SELECT 1 FROM thread_entries
             WHERE team_id = ${teamId} AND thread_id = ${run.thread_id}
               AND entry_id = ${run.parent_entry_id}`)
          ).rows.length > 0
        ? run.parent_entry_id
        : null;
  const at = new Date();
  // Pi's shape for a user message entry, so the chat, Edit and Fork treat it like any prompt.
  const payload = {
    type: "message",
    id: entryId,
    parentId: parent,
    timestamp: at.toISOString(),
    message: {
      role: "user",
      content: [{ type: "text", text: run.input }],
      timestamp: at.getTime(),
    },
  };
  const inserted = await tx
    .insert(threadEntries)
    .values({
      teamId,
      threadId: run.thread_id,
      entryId,
      parentId: parent,
      type: "message",
      payload,
    })
    .onConflictDoNothing()
    .returning({ entryId: threadEntries.entryId });
  await setUserEntry(tx, teamId, runId, entryId);
  if (inserted.length === 0) return [];
  if (moveLeaf) {
    await tx.execute(sql`
      UPDATE threads SET leaf_entry_id = ${entryId}, last_activity_at = now()
       WHERE team_id = ${teamId} AND id = ${run.thread_id}`);
  }
  return entryCommittedEvents([payload], () => undefined);
}

/**
 * Keeps the prompt of a message run that ends (or ended) before Pi's first `turn_end`, from
 * `source`; without one it only binds `runs.user_entry_id` to a prompt already mirrored. Returns
 * `entry.committed` events for what it wrote: the end transaction appends them before the run's
 * terminal event (a run that has already ended gets none). Locks thread, then run.
 */
export async function keepRunPromptInTx(
  tx: KobeTx,
  teamId: string,
  runId: string,
  source: PromptSource | undefined,
  options: { readonly leaf: LeafMove; readonly maxEntries?: number },
): Promise<NewRunEvent[]> {
  const run = await lockPromptRun(tx, teamId, runId);
  if (run?.kind !== "message") return [];
  if ((await bindUserEntry(tx, teamId, runId)) !== null || source === undefined) return [];
  const moveLeaf = options.leaf === "always" || (await isLatestRun(tx, teamId, runId, run));
  return source.kind === "pi"
    ? mirrorPiPrompt(
        tx,
        teamId,
        runId,
        run,
        source.entries,
        moveLeaf,
        options.maxEntries ?? WIRE_DEFAULTS.threadMaxEntries,
      )
    : writeUnsentPrompt(tx, teamId, runId, run, moveLeaf);
}

/**
 * The prompt at the end of a run that was active (end transaction, thread and run locked). With
 * no `source`, a run no sandbox ever leased never reached Pi: its prompt is the server's to keep.
 */
export async function keepPromptAtEndInTx(
  tx: KobeTx,
  teamId: string,
  runId: string,
  source?: PromptSource,
): Promise<NewRunEvent[]> {
  if (source !== undefined) return keepRunPromptInTx(tx, teamId, runId, source, { leaf: "always" });
  const lease = await tx.execute(sql`
    SELECT 1 FROM sandbox_run_leases WHERE team_id = ${teamId} AND run_id = ${runId}`);
  return keepRunPromptInTx(
    tx,
    teamId,
    runId,
    lease.rows.length === 0 ? { kind: "never_reached_pi" } : undefined,
    { leaf: "always" },
  );
}

/**
 * Where Pi continues from for a run that starts at `entryId` (the thread's leaf or a chosen
 * entry): an unsent prompt is not in Pi's session, so its parent (repeatedly). Null: Pi's leaf.
 */
export async function piBranchPoint(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  entryId: string | null,
): Promise<string | null> {
  let at = entryId;
  for (let hops = 0; at !== null && isUnsentPromptEntryId(at) && hops < 64; hops += 1) {
    const res = await tx.execute<{ parent_id: string | null }>(sql`
      SELECT parent_id FROM thread_entries
       WHERE team_id = ${teamId} AND thread_id = ${threadId} AND entry_id = ${at}`);
    at = res.rows[0]?.parent_id ?? null;
  }
  return at;
}

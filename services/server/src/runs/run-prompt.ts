import type { PiGetEntriesData, PiSessionEntry } from "@kobe/protocol";
import { sql, threadEntries, type KobeTx } from "@kobe/db";
import type { NewRunEvent } from "../event-stream/append.js";
import { WIRE_DEFAULTS } from "../sandbox-wire/constants.js";
import { listRunAttachments } from "../uploads/attach-list.js";
import { gatewayModelOf } from "./models.js";
import { findRunPrompt, type FoundPrompt, type PromptRunRecord } from "./run-prompt-pi.js";
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
 * - Pi has the prompt: its own entry (Pi's id, parent and branch), found by the entry tree from
 *   the run's branch point and checked against `runs.input` ({@link findRunPrompt}); nothing else
 *   of an ended run is accepted, and it counts against the run's byte budget.
 * - Pi never received it (no sandbox ever leased the run, or Pi's entries show no prompt of the
 *   run after a refused start): the server writes it, Pi-shaped, under the run's branch point,
 *   with an id Pi can't have ({@link unsentPromptEntryId}; the mirror refuses such ids from a
 *   sandbox). Pi doesn't know it, so it is never the sync cursor, never restored, and never where
 *   Pi continues from ({@link piBranchPoint}).
 * - Unknown (a sandbox holds the run but its entries can't be read, or show something else where
 *   the prompt should be): nothing is written. Pi's entry comes back with the next sync.
 */
export type PromptSource =
  | {
      readonly kind: "pi";
      readonly entries: PiGetEntriesData;
      /** No valid prompt of the run in Pi's entries: keep nothing, or the server's copy. */
      readonly otherwise: "nothing" | "unsent";
    }
  | { readonly kind: "never_reached_pi" };

/** What keeping found: kept, already bound, or why nothing was kept. */
export type KeepOutcome = "kept" | "bound" | "skipped" | FoundPrompt["kind"];

export interface KeptPrompt {
  readonly outcome: KeepOutcome;
  /** `entry.committed` for what was written (appendable while the run has not ended). */
  readonly events: readonly NewRunEvent[];
}

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

/** What the server itself knows of the run's prompt: its text, branch, files and model. */
async function promptRecord(
  tx: KobeTx,
  teamId: string,
  runId: string,
  run: PromptRun,
): Promise<PromptRunRecord> {
  const started = await tx.execute<{ model: string | null }>(sql`
    SELECT payload ->> 'model' AS model FROM run_events
     WHERE team_id = ${teamId} AND run_id = ${runId} AND type = 'run.started'
     ORDER BY seq LIMIT 1`);
  const alias = started.rows[0]?.model ?? undefined;
  return {
    id: runId,
    input: run.input,
    parentEntryId: run.parent_entry_id,
    attachments: await listRunAttachments(tx, teamId, run.thread_id, runId),
    gatewayModel: await gatewayModelOf(tx, alias),
  };
}

/** Not already some other run's prompt (a stop-then-resend race, or a forged reuse). */
async function boundElsewhere(
  tx: KobeTx,
  teamId: string,
  runId: string,
  run: PromptRun,
  id: string,
) {
  const res = await tx.execute(sql`
    SELECT 1 FROM runs
     WHERE team_id = ${teamId} AND thread_id = ${run.thread_id} AND id <> ${runId}
       AND user_entry_id = ${id}
     LIMIT 1`);
  return res.rows.length > 0;
}

/** Adds `bytes` to the run's sandbox bytes if they fit its budget (the active path's rule). */
async function chargeBytes(
  tx: KobeTx,
  teamId: string,
  runId: string,
  bytes: number,
  maxBytes: number,
): Promise<boolean> {
  const res = await tx.execute(sql`
    UPDATE runs SET sandbox_bytes = sandbox_bytes + ${bytes}
     WHERE team_id = ${teamId} AND id = ${runId} AND sandbox_bytes + ${bytes} <= ${maxBytes}
    RETURNING 1`);
  return res.rows.length === 1;
}

async function mirrorPiPrompt(
  tx: KobeTx,
  teamId: string,
  runId: string,
  run: PromptRun,
  chain: readonly PiSessionEntry[],
  moveLeaf: boolean,
  limits: { readonly maxEntries: number; readonly maxBytes: number },
): Promise<KeptPrompt> {
  const prompt = chain.at(-1);
  if (prompt === undefined || (await boundElsewhere(tx, teamId, runId, run, prompt.id))) {
    return { outcome: "mismatch", events: [] };
  }
  const bytes = chain.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e), "utf8"), 0);
  if (!(await chargeBytes(tx, teamId, runId, bytes, limits.maxBytes))) {
    return { outcome: "skipped", events: [] };
  }
  const mirrored = await mirrorEntriesInTx(
    tx,
    teamId,
    run.thread_id,
    { entries: [...chain], leafId: moveLeaf ? prompt.id : null },
    limits.maxEntries,
  );
  const stored = await tx.execute(sql`
    SELECT 1 FROM thread_entries
     WHERE team_id = ${teamId} AND thread_id = ${run.thread_id} AND entry_id = ${prompt.id}`);
  if (stored.rows.length === 0) return { outcome: "skipped", events: [] };
  await setUserEntry(tx, teamId, runId, prompt.id);
  return { outcome: "kept", events: entryCommittedEvents(mirrored.inserted, () => undefined) };
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
 * `source`; without one it only binds `runs.user_entry_id` to a prompt already mirrored. The
 * end transaction appends the returned events before the run's terminal event (a run that has
 * already ended gets none). Locks thread, then run.
 */
export async function keepRunPromptInTx(
  tx: KobeTx,
  teamId: string,
  runId: string,
  source: PromptSource | undefined,
  options: {
    readonly leaf: LeafMove;
    readonly maxEntries?: number;
    readonly maxBytes?: number;
  },
): Promise<KeptPrompt> {
  const run = await lockPromptRun(tx, teamId, runId);
  if (run?.kind !== "message") return { outcome: "skipped", events: [] };
  if ((await bindUserEntry(tx, teamId, runId)) !== null) return { outcome: "bound", events: [] };
  if (source === undefined) return { outcome: "skipped", events: [] };
  const moveLeaf = options.leaf === "always" || (await isLatestRun(tx, teamId, runId, run));
  if (source.kind === "never_reached_pi") {
    return { outcome: "kept", events: await writeUnsentPrompt(tx, teamId, runId, run, moveLeaf) };
  }
  const found = findRunPrompt(source.entries.entries, await promptRecord(tx, teamId, runId, run));
  const kept =
    found.kind === "valid"
      ? await mirrorPiPrompt(tx, teamId, runId, run, found.chain, moveLeaf, {
          maxEntries: options.maxEntries ?? WIRE_DEFAULTS.threadMaxEntries,
          maxBytes: options.maxBytes ?? WIRE_DEFAULTS.runMaxBytes,
        })
      : { outcome: found.kind, events: [] };
  if (kept.outcome === "kept" || source.otherwise === "nothing") return kept;
  // A refused start: Pi has no prompt of this run (or not this run's text): the server's copy.
  return { outcome: "kept", events: await writeUnsentPrompt(tx, teamId, runId, run, moveLeaf) };
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
): Promise<readonly NewRunEvent[]> {
  if (source !== undefined) {
    return (await keepRunPromptInTx(tx, teamId, runId, source, { leaf: "always" })).events;
  }
  const lease = await tx.execute(sql`
    SELECT 1 FROM sandbox_run_leases WHERE team_id = ${teamId} AND run_id = ${runId}`);
  const kept = await keepRunPromptInTx(
    tx,
    teamId,
    runId,
    lease.rows.length === 0 ? { kind: "never_reached_pi" } : undefined,
    { leaf: "always" },
  );
  return kept.events;
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

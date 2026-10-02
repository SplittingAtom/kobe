import {
  isKobeEventType,
  isTerminalEventType,
  parseEventPayload,
  type KobeEvent,
  type KobeEventType,
} from "@kobe/protocol";
import { runEvents, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { encodeHint, RUN_EVENTS_CHANNEL } from "./notify.js";

/**
 * Most events one append may write. Each row bumps `runs.last_seq` under the run's row lock (KOBE-29
 * decision 11), so batches stay at tens of rows and commit promptly; split larger backlogs into
 * several transactions (the batcher does).
 */
export const MAX_APPEND_BATCH = 64;

/** Lock wait for appends that own their transaction: a stuck status writer surfaces as an error. */
export const APPEND_LOCK_TIMEOUT = "5s";

/** An event as a producer hands it over; `run_id`, `seq` and `ts` are assigned on write. */
export interface NewRunEvent {
  readonly type: string;
  readonly payload: unknown;
}

export type AppendErrorCode =
  | "invalid_event" // unknown type or payload that fails its @kobe/protocol schema
  | "batch_too_large" // more than MAX_APPEND_BATCH events
  | "terminal_not_last" // a terminal run.* event followed by more events in the batch
  | "run_not_found" // no such run in the transaction's team
  | "run_finished"; // the run already has its terminal event

export class AppendError extends Error {
  constructor(
    readonly code: AppendErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppendError";
  }
}

interface ValidEvent {
  readonly type: KobeEventType;
  readonly payload: Record<string, unknown>;
}

function validate(events: readonly NewRunEvent[]): ValidEvent[] {
  if (events.length > MAX_APPEND_BATCH) {
    throw new AppendError(
      "batch_too_large",
      `at most ${MAX_APPEND_BATCH} events per append (got ${events.length})`,
    );
  }
  return events.map((event, i) => {
    if (!isKobeEventType(event.type)) {
      throw new AppendError("invalid_event", `event ${i}: unknown type ${String(event.type)}`);
    }
    let payload: Record<string, unknown>;
    try {
      payload = parseEventPayload(event.type, event.payload) as Record<string, unknown>;
    } catch (err) {
      throw new AppendError("invalid_event", `event ${i} (${event.type}): ${String(err)}`);
    }
    // jsonb cannot store U+0000; refuse with a clear error instead of a driver failure mid-batch.
    if (JSON.stringify(payload).includes("\\u0000")) {
      throw new AppendError("invalid_event", `event ${i} (${event.type}): contains U+0000`);
    }
    if (isTerminalEventType(event.type) && i !== events.length - 1) {
      throw new AppendError("terminal_not_last", `event ${i} (${event.type}) must be the last`);
    }
    return { type: event.type, payload };
  });
}

/**
 * Appends events to a run inside the caller's transaction, which must be a `withTeam(teamId)`
 * transaction in READ COMMITTED (the default). Postgres first, then fan-out: the NOTIFY hint is
 * queued in the same transaction, and Postgres delivers it only if and when the transaction
 * commits, so a listener never hears of an event it can't read.
 *
 * Locks the run row until commit (as the seq trigger would anyway). Lock order: a transaction
 * that also writes the run's thread must lock the thread row first (KOBE-29). Keep the
 * transaction short and free of network I/O. To end a run, set its terminal status and append
 * its terminal event in the same transaction: readers treat "run ended" + "caught up" as the end
 * of the stream.
 */
export async function appendRunEventsInTx(
  tx: KobeTx,
  teamId: string,
  runId: string,
  events: readonly NewRunEvent[],
): Promise<KobeEvent[]> {
  return appendValid(tx, teamId, runId, validate(events));
}

async function appendValid(
  tx: KobeTx,
  teamId: string,
  runId: string,
  valid: readonly ValidEvent[],
): Promise<KobeEvent[]> {
  if (valid.length === 0) return [];

  const locked = await tx.execute<{ last_type: string | null }>(sql`
    SELECT (SELECT e.type FROM run_events e
             WHERE e.team_id = r.team_id AND e.run_id = r.id AND e.seq = r.last_seq) AS last_type
      FROM runs r
     WHERE r.team_id = ${teamId} AND r.id = ${runId}
       FOR NO KEY UPDATE OF r`);
  const run = locked.rows[0];
  if (!run) throw new AppendError("run_not_found", `run ${runId} not found in the active team`);
  if (
    run.last_type !== null &&
    isKobeEventType(run.last_type) &&
    isTerminalEventType(run.last_type)
  )
    throw new AppendError("run_finished", `run ${runId} already ended with ${run.last_type}`);

  // Rows get seq in VALUES order (row trigger); RETURNING order is not guaranteed, so sort.
  const rows = await tx
    .insert(runEvents)
    .values(valid.map((e) => ({ teamId, runId, type: e.type, payload: e.payload })))
    .returning({
      seq: runEvents.seq,
      type: runEvents.type,
      payload: runEvents.payload,
      createdAt: runEvents.createdAt,
    });
  rows.sort((a, b) => a.seq - b.seq);
  const last = rows[rows.length - 1];
  if (!last) return [];
  await tx.execute(
    sql`SELECT pg_notify(${RUN_EVENTS_CHANNEL}, ${encodeHint({ runId, seq: last.seq })})`,
  );
  return rows.map(
    (r) =>
      ({
        run_id: runId,
        seq: r.seq,
        ts: r.createdAt.toISOString(),
        type: r.type,
        payload: r.payload,
      }) as KobeEvent,
  );
}

/** Appends in a transaction of its own (with a lock timeout); commits before returning. */
export async function appendRunEvents(
  db: KobeDb,
  teamId: string,
  runId: string,
  events: readonly NewRunEvent[],
): Promise<KobeEvent[]> {
  const valid = validate(events); // fail before opening a transaction
  if (valid.length === 0) return [];
  return withTeam(db, teamId, async (tx) => {
    await tx.execute(sql`SELECT set_config('lock_timeout', ${APPEND_LOCK_TIMEOUT}, true)`);
    return appendValid(tx, teamId, runId, valid);
  });
}

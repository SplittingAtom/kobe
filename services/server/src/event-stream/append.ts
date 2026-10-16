import {
  EPILOGUE_EVENT_TYPES,
  EVENT_PAYLOAD_MAX_BYTES,
  SERVER_CALL_EPILOGUE_MAX_MS,
  EventPayloadTooLargeError,
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

/**
 * Largest stored payload per event (UTF-8 JSON): the protocol bound (`EVENT_PAYLOAD_MAX_BYTES`,
 * checked by `parseEventPayload`). Larger content belongs in S3 by `blob_ref` (D15).
 */
export const MAX_EVENT_PAYLOAD_BYTES = EVENT_PAYLOAD_MAX_BYTES;

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
  | "payload_too_large" // one payload over MAX_EVENT_PAYLOAD_BYTES
  | "terminal_not_last" // a terminal run.* event followed by more events in the batch
  | "run_not_found" // no such run in the transaction's team
  | "run_finished" // the run already has its terminal event
  | "epilogue_refused"; // an epilogue event the run's run.completed did not leave room for

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
      if (err instanceof EventPayloadTooLargeError) {
        throw new AppendError(
          "payload_too_large",
          `event ${i} (${event.type}): payload over ${MAX_EVENT_PAYLOAD_BYTES} bytes`,
        );
      }
      throw new AppendError("invalid_event", `event ${i} (${event.type}): ${String(err)}`);
    }
    const json = JSON.stringify(payload);
    // jsonb cannot store U+0000; refuse with a clear error instead of a driver failure mid-batch.
    if (json.includes("\\u0000")) {
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

  // Lock first, then read in a separate statement. In READ COMMITTED a statement that waited on the
  // row lock re-checks only the locked row; a subselect in the same statement would keep its
  // pre-wait snapshot and miss a terminal event committed by the lock holder (review HIGH-1). The
  // next statement takes a fresh snapshot that includes everything committed before we got the lock.
  const locked = await tx.execute<{ id: string }>(sql`
    SELECT r.id FROM runs r
     WHERE r.team_id = ${teamId} AND r.id = ${runId}
       FOR NO KEY UPDATE OF r`);
  if (!locked.rows[0])
    throw new AppendError("run_not_found", `run ${runId} not found in the active team`);
  await checkRunOpen(tx, teamId, runId, valid);

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
  const newest = rows[rows.length - 1];
  if (!newest) return [];
  await tx.execute(
    sql`SELECT pg_notify(${RUN_EVENTS_CHANNEL}, ${encodeHint({ runId, seq: newest.seq })})`,
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

/** Epilogue event types (KOBE-234) by the server call that writes them. */
const EPILOGUE_TYPES: ReadonlyMap<KobeEventType, string> = new Map(
  Object.entries(EPILOGUE_EVENT_TYPES).map(([purpose, type]) => [type as KobeEventType, purpose]),
);
/**
 * At most one event per epilogue purpose follows a terminal event, so a run's terminal event, if
 * any, is among its last `1 + purposes` events.
 */
const TAIL = 1 + EPILOGUE_TYPES.size;

/**
 * The run must still take these events (call with the run row locked). Before its terminal event
 * anything but an epilogue event goes. After it, only the epilogue (KOBE-234,
 * `@kobe/protocol` server-call.ts): the event types `run.completed.epilogue` announced, each at
 * most once per run, within `SERVER_CALL_EPILOGUE_MAX_MS` of `run.completed` (database clock);
 * everything else is `run_finished`, so an epilogue event at the end never reopens the run.
 */
async function checkRunOpen(
  tx: KobeTx,
  teamId: string,
  runId: string,
  valid: readonly ValidEvent[],
): Promise<void> {
  const tail = await tx.execute<{ type: string; payload: unknown; age_ms: number }>(sql`
    SELECT e.type, e.payload,
           (extract(epoch FROM clock_timestamp() - e.created_at) * 1000)::float8 AS age_ms
      FROM runs r
      JOIN run_events e ON e.team_id = r.team_id AND e.run_id = r.id AND e.seq > r.last_seq - ${TAIL}
     WHERE r.team_id = ${teamId} AND r.id = ${runId}
     ORDER BY e.seq`);
  const at = tail.rows.findIndex((r) => isKobeEventType(r.type) && isTerminalEventType(r.type));
  const terminal = at < 0 ? undefined : tail.rows[at];
  const epilogue = valid.filter((e) => EPILOGUE_TYPES.has(e.type));
  if (!terminal) {
    if (epilogue.length > 0) {
      throw new AppendError("epilogue_refused", `run ${runId} has not completed`);
    }
    return;
  }
  if (epilogue.length < valid.length) {
    throw new AppendError("run_finished", `run ${runId} already ended with ${terminal.type}`);
  }
  const announced =
    terminal.type === "run.completed"
      ? ((terminal.payload as { epilogue?: readonly string[] }).epilogue ?? [])
      : [];
  const seen = new Set(tail.rows.slice(at + 1).map((r) => r.type));
  for (const e of epilogue) {
    const purpose = EPILOGUE_TYPES.get(e.type) ?? "";
    if (!announced.includes(purpose) || seen.has(e.type)) {
      throw new AppendError("epilogue_refused", `run ${runId}: ${e.type} is not expected`);
    }
    seen.add(e.type);
  }
  if (Number(terminal.age_ms) >= SERVER_CALL_EPILOGUE_MAX_MS) {
    throw new AppendError("epilogue_refused", `run ${runId}: the epilogue window has closed`);
  }
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
  return withAppendTx(db, teamId, (tx) => appendValid(tx, teamId, runId, valid));
}

/**
 * `withTeam(teamId)` plus `SET LOCAL lock_timeout` (APPEND_LOCK_TIMEOUT), for callers that combine
 * `appendRunEventsInTx` with their own writes (KOBE-24: `runs.sandbox_seq`; KOBE-30: run status), so
 * a stuck lock holder surfaces as an error (55P03) instead of a hung writer.
 */
export async function withAppendTx<T>(
  db: KobeDb,
  teamId: string,
  fn: (tx: KobeTx) => Promise<T>,
): Promise<T> {
  return withTeam(db, teamId, async (tx) => {
    await tx.execute(sql`SELECT set_config('lock_timeout', ${APPEND_LOCK_TIMEOUT}, true)`);
    return fn(tx);
  });
}

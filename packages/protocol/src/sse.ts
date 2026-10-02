import type { KobeEvent } from "./events.js";

/**
 * SSE framing and resume semantics for `GET /v1/runs/{id}/events` (spec §6.2, D16).
 *
 * Framing — one event per SSE message:
 *
 *     id: <seq>
 *     event: <type>
 *     data: <JSON of the full envelope {run_id, seq, ts, type, payload}>
 *     <blank line>
 *
 * `data` is always a single line (JSON.stringify escapes CR/LF; U+2028/9 are not SSE line breaks).
 * The server sends `: keepalive` comments every {@link SSE_KEEPALIVE_MS} and `retry:` once at the
 * start. Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
 * `X-Accel-Buffering: no`.
 *
 * Resume — the cursor is the last `seq` the client has:
 * - cursor = **max**(`?starting_after`, `Last-Event-ID`), each 0 when absent. (Max, not "query
 *   wins": on EventSource auto-reconnect the URL still carries the original, stale `starting_after`
 *   while `Last-Event-ID` is fresh; preferring the query would replay and loop.)
 * - The server replays every `run_events` row with `seq > cursor` from Postgres, then streams live
 *   events (LISTEN/NOTIFY is only a hint to re-read; Postgres is the record). Replay and live are
 *   merged so no seq is sent twice and none is skipped (seq is gapless, KOBE-29).
 * - After a terminal event (`TERMINAL_EVENT_TYPES`) the server ends the response. EventSource then
 *   reconnects with `Last-Event-ID` = the terminal seq; for a run that has ended and has no events
 *   after the cursor the server answers **204 No Content**, which tells EventSource to stop.
 * - Compacted runs (`runs.events_compacted_at` set, D18: events folded into entries after 7 days):
 *   the server answers **410 Gone** with `{"error":{"code":"events_compacted"}}` whatever the
 *   cursor; EventSource stops (non-200), and the client renders the thread from
 *   `GET /v1/threads/{id}` entries instead. Clients only ever stream runs that are active or
 *   recently ended, so this is the reload-an-old-thread path.
 * - Clients drop any event with `seq <= last seen` (duplicates across reconnects).
 * - A malformed cursor is a 400, not a silent restart from 0.
 */

export const SSE_KEEPALIVE_MS = 15_000;
export const SSE_RETRY_MS = 2_000;
export const SSE_KEEPALIVE_FRAME = ": keepalive\n\n";

export function formatSseEvent(event: KobeEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function formatSseRetry(ms: number = SSE_RETRY_MS): string {
  return `retry: ${ms}\n\n`;
}

const CURSOR = /^(0|[1-9][0-9]{0,15})$/;

function present(value: string | null | undefined): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : value;
}

export type ResumeCursorResult =
  | { readonly ok: true; readonly after: number }
  | { readonly ok: false; readonly error: "invalid_cursor" };

/** Resolve the resume cursor from the query parameter and the `Last-Event-ID` header. */
export function resolveResumeCursor(input: {
  readonly startingAfter?: string | null | undefined;
  readonly lastEventId?: string | null | undefined;
}): ResumeCursorResult {
  let after = 0;
  for (const raw of [present(input.startingAfter), present(input.lastEventId)]) {
    if (raw === undefined) continue;
    if (!CURSOR.test(raw)) return { ok: false, error: "invalid_cursor" };
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) return { ok: false, error: "invalid_cursor" };
    after = Math.max(after, value);
  }
  return { ok: true, after };
}

/** What `GET /v1/runs/{id}/events` answers before streaming. */
export type StreamOpenDecision =
  | { readonly kind: "stream" }
  | { readonly kind: "no_content" } // 204: ended run, nothing after the cursor
  | { readonly kind: "gone" }; // 410: events compacted into entries

export function decideStreamOpen(run: {
  readonly ended: boolean;
  readonly events_compacted: boolean;
  readonly last_seq: number;
  readonly cursor: number;
}): StreamOpenDecision {
  if (run.events_compacted) return { kind: "gone" };
  if (run.ended && run.cursor >= run.last_seq) return { kind: "no_content" };
  return { kind: "stream" };
}

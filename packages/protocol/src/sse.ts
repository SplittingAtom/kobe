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
 * - `?starting_after=<seq>` wins when present; otherwise the `Last-Event-ID` header; otherwise 0.
 * - The server replays every `run_events` row with `seq > cursor` from Postgres, then streams live
 *   events (LISTEN/NOTIFY is only a hint to re-read; Postgres is the record). Replay and live are
 *   merged so no seq is sent twice and none is skipped.
 * - After a terminal event (`TERMINAL_EVENT_TYPES`) the server ends the response. Connecting to a
 *   finished run replays from the cursor and then ends; a cursor at/after the terminal event yields
 *   an empty, immediately closed stream.
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
  const raw = present(input.startingAfter) ?? present(input.lastEventId);
  if (raw === undefined) return { ok: true, after: 0 };
  if (!CURSOR.test(raw)) return { ok: false, error: "invalid_cursor" };
  const after = Number(raw);
  if (!Number.isSafeInteger(after)) return { ok: false, error: "invalid_cursor" };
  return { ok: true, after };
}

/**
 * One run's Kobe Event Stream in the browser (KOBE-31): an `EventSource` on
 * `GET /v1/runs/{id}/events?starting_after=<seq>` with the session cookie (EventSource can't send
 * `X-Kobe-Team`; the server doesn't need it on GET). The browser reconnects by itself with
 * `Last-Event-ID` after a network drop; the server takes max(starting_after, Last-Event-ID), so
 * nothing is missed, and anything at or below the last seq we hold is dropped here.
 *
 * EventSource hides HTTP statuses: when the server refuses a (re)connection (204 after the end,
 * 410 compacted, 404, 409, 400) the source just closes. The stream then reports `closed` and the
 * caller asks the API what happened (run ended → render from entries; still active → reopen).
 */
import {
  KOBE_EVENT_TYPES,
  isTerminalEventType,
  kobeEventSchema,
  type KobeEvent,
} from "@kobe/protocol";
import "../security/zod-jitless";
import { runEventsUrl } from "./api";

/** The part of `EventSource` used here, so tests can drive the stream without a browser. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export const CLOSED = 2;

export const browserEventSource: EventSourceFactory = (url) =>
  new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike;

export type StreamSignal =
  /** Connected (first time or after a reconnect). */
  | { readonly kind: "open" }
  /** The connection dropped; the browser is reconnecting with Last-Event-ID. */
  | { readonly kind: "reconnecting" }
  /** The server ended or refused the stream; ask the API what state the run is in. */
  | { readonly kind: "closed" };

export interface RunStreamHandlers {
  /** Events in seq order, never one at or below a seq already delivered. */
  readonly onEvents: (events: readonly KobeEvent[]) => void;
  readonly onSignal: (signal: StreamSignal) => void;
}

export interface RunStream {
  readonly runId: string;
  close(): void;
}

/** Events are delivered in small batches (one per frame) so a replay renders once, not per delta. */
const FLUSH_MS = 32;

export function openRunStream(
  runId: string,
  startingAfter: number,
  handlers: RunStreamHandlers,
  factory: EventSourceFactory = browserEventSource,
): RunStream {
  let lastSeq = startingAfter;
  let closed = false;
  let buffer: KobeEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const source = factory(runEventsUrl(runId, startingAfter));

  const flush = () => {
    timer = undefined;
    if (buffer.length === 0 || closed) return;
    const batch = buffer;
    buffer = [];
    handlers.onEvents(batch);
  };

  const finish = (signal: StreamSignal | undefined) => {
    if (closed) return;
    flush();
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    source.close();
    if (signal) handlers.onSignal(signal);
  };

  const onMessage = (message: MessageEvent<string>) => {
    if (closed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      return; // not a Kobe event; the seq cursor is unchanged
    }
    const result = kobeEventSchema.safeParse(parsed);
    if (!result.success || result.data.run_id !== runId || result.data.seq <= lastSeq) return;
    lastSeq = result.data.seq;
    buffer.push(result.data);
    if (isTerminalEventType(result.data.type)) {
      // The server ends the response after a terminal event; don't let the browser reconnect.
      finish({ kind: "closed" });
      return;
    }
    timer ??= setTimeout(flush, FLUSH_MS);
  };

  for (const type of KOBE_EVENT_TYPES) source.addEventListener(type, onMessage);
  source.onopen = () => {
    if (!closed) handlers.onSignal({ kind: "open" });
  };
  source.onerror = () => {
    if (closed) return;
    if (source.readyState === CLOSED) finish({ kind: "closed" });
    else {
      flush();
      handlers.onSignal({ kind: "reconnecting" });
    }
  };

  return { runId, close: () => finish(undefined) };
}

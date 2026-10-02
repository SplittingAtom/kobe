import {
  formatSseEvent,
  formatSseRetry,
  isKobeEventType,
  isTerminalEventType,
  SSE_KEEPALIVE_FRAME,
  SSE_KEEPALIVE_MS,
  SSE_RETRY_MS,
} from "@kobe/protocol";
import { logger as rootLogger } from "../logger.js";
import type { HubSubscriber, RunEventHub } from "./hub.js";
import type { Page } from "./read.js";

export interface StreamTimings {
  /** `: keepalive` cadence; each tick also re-reads Postgres (a safety net for lost hints). */
  readonly keepaliveMs: number;
  /** A client that has not taken the last chunk for this long is disconnected (it resumes later). */
  readonly stallTimeoutMs: number;
  /** How often a long-lived stream re-checks the session, membership and visibility. */
  readonly revalidateMs: number;
  /** `retry:` sent to EventSource at the start of every stream. */
  readonly retryMs: number;
}

export const STREAM_DEFAULTS: StreamTimings = {
  keepaliveMs: SSE_KEEPALIVE_MS,
  stallTimeoutMs: 60_000,
  revalidateMs: 30_000,
  retryMs: SSE_RETRY_MS,
};

export interface StreamSource {
  /** Events after `after` plus the run's state (one snapshot), from Postgres. */
  read(after: number): Promise<Page>;
  /** Whether the caller may still watch the run (session live, still a member, still visible). */
  revalidate(): Promise<boolean>;
}

export interface RunEventStreamInput {
  readonly runId: string;
  /** Resume cursor: the last seq the client has. */
  readonly cursor: number;
  readonly source: StreamSource;
  readonly hub: RunEventHub;
  readonly timings?: Partial<StreamTimings>;
  /** Called exactly once when the stream ends for any reason (frees the user's slot). */
  readonly onEnd?: (reason: StreamEndReason) => void;
  /**
   * Tears down the underlying connection (Node: destroy the socket). Needed for stalled clients:
   * the HTTP layer waits for the socket to drain before it reads the stream again, so ending the
   * stream alone would never reach a client that stopped reading. Without it the stream errors.
   */
  readonly abortConnection?: (() => void) | undefined;
}

export type StreamEndReason =
  | "terminal" // terminal event sent, or run ended and fully delivered
  | "gone" // run deleted or compacted while streaming
  | "revoked" // session, membership or visibility lost
  | "client_closed"
  | "slow_consumer"
  | "shutdown"
  | "error";

const encoder = new TextEncoder();

/**
 * The SSE body for one run (spec §6.2): replay from Postgres after the cursor, then live, as one
 * sequence. Pull-based: Postgres is read only when the client has taken the previous chunk, so a
 * slow client never makes the server buffer more than one page (≤ PAGE_MAX_ROWS / PAGE_MAX_BYTES)
 * plus socket buffers; Postgres is the buffer. Hub hints while the client is behind only set a flag.
 *
 * Gapless and duplicate-free: every read asks for `seq > lastSent`, and seq is gapless with commit
 * order = seq order (KOBE-29), so whatever was read is a contiguous run of events after lastSent.
 * The subscription is registered before the first read, so no commit can fall between them.
 */
export function createRunEventStream(input: RunEventStreamInput): ReadableStream<Uint8Array> {
  const t = { ...STREAM_DEFAULTS, ...input.timings };
  const log = rootLogger.child({ component: "run-event-stream", runId: input.runId });
  let lastSent = input.cursor;
  let dirty = true;
  let keepaliveDue = false;
  let revalidateDue = false;
  let endReason: StreamEndReason | undefined;
  let ended = false;
  let pulling = false;
  let lastChunkAt = Date.now();
  let lastRevalidateAt = Date.now();
  let wake: (() => void) | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let unsubscribe: (() => void) | undefined;
  let ticker: NodeJS.Timeout | undefined;

  const signal = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };

  const cleanup = (reason: StreamEndReason) => {
    if (ended) return;
    ended = true;
    unsubscribe?.();
    if (ticker) clearInterval(ticker);
    signal();
    input.onEnd?.(reason);
  };

  /** Ends the stream now (not from inside pull). */
  const endNow = (reason: StreamEndReason, error?: Error) => {
    if (ended) return;
    cleanup(reason);
    try {
      if (error) controller?.error(error);
      else controller?.close();
    } catch {
      // already closed or errored
    }
  };

  const finish = (reason: StreamEndReason) => {
    endReason ??= reason;
    if (pulling) signal();
    else endNow(reason);
  };

  const subscriber: HubSubscriber = {
    hint(seq) {
      if (seq > lastSent) {
        dirty = true;
        signal();
      }
    },
    resync() {
      dirty = true;
      signal();
    },
    close: () => finish("shutdown"),
  };

  const tick = () => {
    const now = Date.now();
    if (!pulling && now - lastChunkAt >= t.stallTimeoutMs) {
      log.info({ lastSent }, "dropping stalled SSE client; it resumes from its cursor");
      if (input.abortConnection) {
        cleanup("slow_consumer");
        input.abortConnection();
      } else {
        endNow("slow_consumer", new Error("slow consumer: client stopped reading"));
      }
      return;
    }
    keepaliveDue = true;
    dirty = true;
    if (now - lastRevalidateAt >= t.revalidateMs) revalidateDue = true;
    signal();
  };

  const enqueue = (ctrl: ReadableStreamDefaultController<Uint8Array>, text: string) => {
    ctrl.enqueue(encoder.encode(text));
    lastChunkAt = Date.now();
    keepaliveDue = false;
  };

  /** One pull: enqueue at most one chunk (a page of events or a keep-alive), or end. */
  const step = async (ctrl: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    for (;;) {
      if (ended) return;
      if (endReason) {
        cleanup(endReason);
        ctrl.close();
        return;
      }
      if (revalidateDue) {
        revalidateDue = false;
        lastRevalidateAt = Date.now();
        if (!(await input.source.revalidate())) {
          endReason ??= "revoked";
          continue;
        }
      }
      if (dirty) {
        dirty = false;
        const page = await input.source.read(lastSent);
        if (ended) return;
        if (!page.run || page.run.compacted) {
          endReason ??= "gone";
          continue;
        }
        if (page.events.length > 0) {
          let text = "";
          for (const event of page.events) {
            if (event.seq <= lastSent) continue;
            text += formatSseEvent(event);
            lastSent = event.seq;
            if (isKobeEventType(event.type) && isTerminalEventType(event.type)) {
              endReason ??= "terminal";
              break;
            }
          }
          if (page.run.lastSeq > lastSent) dirty = true;
          if (text) {
            enqueue(ctrl, text);
            return;
          }
        }
        if (page.run.ended && page.run.lastSeq <= lastSent) {
          endReason ??= "terminal";
          continue;
        }
      }
      if (keepaliveDue) {
        enqueue(ctrl, SSE_KEEPALIVE_FRAME);
        return;
      }
      if (dirty || revalidateDue || endReason) continue;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  };

  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
      unsubscribe = input.hub.subscribe(input.runId, subscriber);
      ctrl.enqueue(encoder.encode(formatSseRetry(t.retryMs)));
      lastChunkAt = Date.now();
      ticker = setInterval(tick, t.keepaliveMs);
      ticker.unref();
    },
    async pull(ctrl) {
      pulling = true;
      try {
        await step(ctrl);
      } catch (err) {
        // Transient database trouble: end cleanly; EventSource reconnects with Last-Event-ID.
        log.warn({ err, lastSent }, "SSE stream read failed; closing for client resume");
        if (!ended) {
          cleanup("error");
          ctrl.close();
        }
      } finally {
        pulling = false;
      }
    },
    cancel() {
      cleanup("client_closed");
    },
  });
}

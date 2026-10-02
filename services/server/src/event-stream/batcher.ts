import { MAX_APPEND_BATCH, type NewRunEvent } from "./append.js";

export interface RunEventBatcherOptions {
  /** Persists one batch, in order (typically `appendRunEvents(db, team, run, events)`). */
  readonly write: (events: NewRunEvent[]) => Promise<void>;
  /** Deltas wait at most this long before being written (KOBE-29: one event per 50–100 ms). */
  readonly windowMs?: number;
  /** A coalesced delta never grows beyond this many UTF-16 units; the next one starts a new event. */
  readonly maxDeltaChars?: number;
  /** Events per write (one transaction); at most MAX_APPEND_BATCH. */
  readonly maxBatchEvents?: number;
  /** `push` stops resolving immediately once this many events wait to be written. */
  readonly highWaterMark?: number;
  /** A write that failed in the background (timer flush). The batcher is failed afterwards. */
  readonly onError?: (err: unknown) => void;
}

export const DELTA_BATCH_DEFAULTS = {
  windowMs: 75,
  maxDeltaChars: 16_384,
  maxBatchEvents: 50,
  highWaterMark: 256,
} as const;

export interface RunEventBatcher {
  /**
   * Queues an event. Consecutive `text.delta` / `reasoning.delta` of the same message part are
   * merged; any other event flushes what is queued (it and everything before it are written
   * promptly, in order). Resolves at once unless `highWaterMark` events are waiting, then when the
   * writer has caught up: await it to push back on the producer (e.g. pause the socket).
   * Rejects once a write has failed.
   */
  push(event: NewRunEvent): Promise<void>;
  /** Writes everything queued now and resolves when it is persisted. */
  flush(): Promise<void>;
  /** Flushes and refuses further events. */
  close(): Promise<void>;
  /** Events waiting to be written (after merging). */
  readonly buffered: number;
}

const DELTA_TYPES = new Set(["text.delta", "reasoning.delta"]);

interface DeltaPayload {
  readonly message_id: string;
  readonly content_index: number;
  readonly delta: string;
}

function asDelta(event: NewRunEvent): DeltaPayload | undefined {
  if (!DELTA_TYPES.has(event.type)) return undefined;
  const p = event.payload as Partial<DeltaPayload> | null;
  if (
    p === null ||
    typeof p !== "object" ||
    typeof p.message_id !== "string" ||
    typeof p.content_index !== "number" ||
    typeof p.delta !== "string" ||
    Object.keys(p).length !== 3
  )
    return undefined; // leave it to validation on write
  return p as DeltaPayload;
}

/** Merges `next` into `prev` when both are deltas of the same message part; else undefined. */
function merge(prev: NewRunEvent, next: NewRunEvent, maxChars: number): NewRunEvent | undefined {
  if (prev.type !== next.type) return undefined;
  const a = asDelta(prev);
  const b = asDelta(next);
  if (!a || !b || a.message_id !== b.message_id || a.content_index !== b.content_index)
    return undefined;
  if (a.delta.length + b.delta.length > maxChars) return undefined;
  return { type: prev.type, payload: { ...a, delta: a.delta + b.delta } };
}

/**
 * Coalesces streaming deltas before they reach `run_events` (KOBE-29 decision 11: each row bumps
 * the run's counter row, so one event per token would make it a hot row). Order is preserved
 * exactly; only adjacent deltas of the same message part are concatenated. One write is in
 * flight at a time. Failure is sticky: the caller re-sends from its own cursor (the sandbox wire
 * acknowledges frames only after their events commit) with a new batcher.
 */
export function createRunEventBatcher(options: RunEventBatcherOptions): RunEventBatcher {
  const windowMs = options.windowMs ?? DELTA_BATCH_DEFAULTS.windowMs;
  const maxChars = options.maxDeltaChars ?? DELTA_BATCH_DEFAULTS.maxDeltaChars;
  const maxBatch = Math.min(
    options.maxBatchEvents ?? DELTA_BATCH_DEFAULTS.maxBatchEvents,
    MAX_APPEND_BATCH,
  );
  const highWaterMark = options.highWaterMark ?? DELTA_BATCH_DEFAULTS.highWaterMark;

  let buffer: readonly NewRunEvent[] = [];
  let timer: NodeJS.Timeout | undefined;
  let draining: Promise<void> | undefined;
  let failed: { error: unknown } | undefined;
  let closed = false;
  let waiters: { resolve: () => void; reject: (err: unknown) => void }[] = [];

  const settleWaiters = () => {
    if (failed) {
      const err = failed.error;
      for (const w of waiters) w.reject(err);
      waiters = [];
    } else if (buffer.length < highWaterMark) {
      for (const w of waiters) w.resolve();
      waiters = [];
    }
  };

  const drain = async (): Promise<void> => {
    while (buffer.length > 0 && !failed) {
      const batch = buffer.slice(0, maxBatch);
      buffer = buffer.slice(maxBatch);
      try {
        await options.write([...batch]);
      } catch (err) {
        failed = { error: err };
        buffer = [];
      }
      settleWaiters();
    }
    if (failed) throw failed.error;
  };

  const kick = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    draining ??= drain().finally(() => {
      draining = undefined;
      // Deltas that arrived after the last loop check still get their window.
      if (buffer.length > 0 && !timer && !failed) armTimer();
    });
    return draining;
  };

  const kickInBackground = () => {
    kick().catch((err: unknown) => options.onError?.(err));
  };

  function armTimer() {
    timer = setTimeout(kickInBackground, windowMs);
    timer.unref();
  }

  const flushAll = async (): Promise<void> => {
    while (draining || buffer.length > 0) {
      if (failed) throw failed.error;
      await kick();
    }
    if (failed) throw failed.error;
  };

  return {
    get buffered() {
      return buffer.length;
    },
    push(event) {
      if (failed) return Promise.reject(failed.error);
      if (closed) return Promise.reject(new Error("run event batcher is closed"));
      const last = buffer[buffer.length - 1];
      const merged = last ? merge(last, event, maxChars) : undefined;
      buffer = merged ? [...buffer.slice(0, -1), merged] : [...buffer, event];
      if (!asDelta(event)) kickInBackground();
      else if (!timer && !draining) armTimer();
      if (buffer.length < highWaterMark) return Promise.resolve();
      return new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
    },
    flush: flushAll,
    async close() {
      closed = true;
      await flushAll();
    },
  };
}

import { formatSseRetry, SSE_KEEPALIVE_FRAME } from "@kobe/protocol";
import type { RunEventHub, WorkspaceHubSubscriber } from "../event-stream/hub.js";
import { STREAM_DEFAULTS, type StreamTimings } from "../event-stream/stream.js";
import { logger as rootLogger } from "../logger.js";

/**
 * The SSE pump behind the workspace streams (`GET /v1/workspace/changes`, KOBE-496, and
 * `GET /v1/workspace/events`, KOBE-599): Postgres is the record; the hub's workspace hint for the
 * user only marks the stream dirty, and hints are coalesced (`debounceMs`), so a push of many
 * files costs one read. The subscription is registered before the first read, so no commit falls
 * between them. Like run streams: keep-alives, a safety read, a periodic revalidation of the
 * viewer (session, membership, role) and a stall cut-off. `produce(first)` reads and returns the
 * SSE text to send (empty: nothing new).
 */
export interface HintStreamInput {
  readonly userId: string;
  readonly hub: RunEventHub;
  /** Logger component name. */
  readonly component: string;
  readonly produce: (first: boolean) => Promise<string>;
  /** Whether the caller may still read their workspace in this team. */
  readonly revalidate: () => Promise<boolean>;
  readonly timings?: Partial<StreamTimings>;
  /** Wait after a hint before reading, so a burst of commits is read once (ms). */
  readonly debounceMs?: number;
  /** Called exactly once when the stream ends (frees the user's slot). */
  readonly onEnd?: () => void;
  /** Tears down the connection of a client that stopped reading (see run streams). */
  readonly abortConnection?: (() => void) | undefined;
}

export const HINT_DEBOUNCE_MS = 250;

const encoder = new TextEncoder();

export function createWorkspaceHintStream(input: HintStreamInput): ReadableStream<Uint8Array> {
  const t = { ...STREAM_DEFAULTS, ...input.timings };
  const debounceMs = input.debounceMs ?? HINT_DEBOUNCE_MS;
  const log = rootLogger.child({ component: input.component });
  let first = true;
  let dirty = true;
  let keepaliveDue = false;
  let revalidateDue = true;
  let ended = false;
  let endRequested = false;
  let lastChunkAt = Date.now();
  let lastRevalidateAt = Date.now();
  let lastReadAt = Date.now();
  let pulling = false;
  let wake: (() => void) | undefined;
  let debounce: NodeJS.Timeout | undefined;
  let ticker: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  const signal = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  const markDirty = () => {
    if (debounce || ended) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      dirty = true;
      signal();
    }, debounceMs);
    debounce.unref();
  };

  const cleanup = () => {
    if (ended) return;
    ended = true;
    unsubscribe?.();
    if (ticker) clearInterval(ticker);
    if (debounce) clearTimeout(debounce);
    signal();
    input.onEnd?.();
  };
  const endNow = () => {
    if (ended) return;
    cleanup();
    try {
      controller?.close();
    } catch {
      // already closed
    }
  };

  const subscriber: WorkspaceHubSubscriber = {
    changed: markDirty,
    resync: markDirty,
    revalidate: () => {
      revalidateDue = true;
      signal();
    },
    close: () => {
      endRequested = true;
      if (pulling) signal();
      else endNow();
    },
  };

  const tick = () => {
    const now = Date.now();
    if (!pulling && now - lastChunkAt >= t.stallTimeoutMs) {
      log.info("dropping stalled workspace stream; it reconnects and catches up");
      cleanup();
      if (input.abortConnection) input.abortConnection();
      else controller?.error(new Error("slow consumer: client stopped reading"));
      return;
    }
    keepaliveDue = true;
    if (now - lastReadAt >= t.safetyReadMs) dirty = true;
    if (now - lastRevalidateAt >= t.revalidateMs) revalidateDue = true;
    signal();
  };

  const enqueue = (ctrl: ReadableStreamDefaultController<Uint8Array>, text: string) => {
    ctrl.enqueue(encoder.encode(text));
    lastChunkAt = Date.now();
    keepaliveDue = false;
  };

  const step = async (ctrl: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    for (;;) {
      if (ended) return;
      if (endRequested) {
        cleanup();
        ctrl.close();
        return;
      }
      if (revalidateDue) {
        revalidateDue = false;
        lastRevalidateAt = Date.now();
        if (!(await input.revalidate())) {
          endRequested = true;
          continue;
        }
      }
      if (dirty) {
        dirty = false;
        lastReadAt = Date.now();
        const text = await input.produce(first);
        if (ended) return;
        first = false;
        if (text) {
          enqueue(ctrl, text);
          return;
        }
      }
      if (keepaliveDue) {
        enqueue(ctrl, SSE_KEEPALIVE_FRAME);
        return;
      }
      if (dirty || revalidateDue || endRequested) continue;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  };

  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
      unsubscribe = input.hub.subscribeWorkspace(input.userId, subscriber);
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
        // Transient database trouble: end cleanly; EventSource reconnects and catches up.
        log.warn({ err }, "workspace stream read failed; closing for client resume");
        if (!ended) {
          cleanup();
          ctrl.close();
        }
      } finally {
        pulling = false;
      }
    },
    cancel() {
      cleanup();
    },
  });
}

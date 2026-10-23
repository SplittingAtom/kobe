import {
  formatSseRetry,
  formatWorkspaceChange,
  SSE_KEEPALIVE_FRAME,
  type WorkspaceFileChange,
} from "@kobe/protocol";
import type { RunEventHub, WorkspaceHubSubscriber } from "../event-stream/hub.js";
import { STREAM_DEFAULTS, type StreamTimings } from "../event-stream/stream.js";
import { logger as rootLogger } from "../logger.js";
import { snapshotOf } from "./changes.js";

/**
 * The SSE body of `GET /v1/workspace/changes` (KOBE-496): one `file.state` per requested path
 * (the catch-up by version after any reconnect), then `file.changed` for each newer revision of
 * those paths. Postgres is the record: the hub's workspace hint only marks the stream dirty, and
 * hints are coalesced (`debounceMs`), so an agent's push of many files costs one read. The
 * subscription is registered before the first read, so no commit falls between them; revisions
 * are handed out under the workspace lock (commit order = revision order), so `rev > last` never
 * skips one. Like run streams: keep-alives, a safety read, a periodic revalidation of the viewer
 * (session, membership, role) and a stall cut-off.
 */
export interface ChangeSource {
  /** Rows of the requested paths with `rev > after`, oldest first (after 0: every path's row). */
  read(after: number): Promise<WorkspaceFileChange[]>;
  /** Whether the caller may still read their workspace in this team. */
  revalidate(): Promise<boolean>;
}

export interface ChangeStreamInput {
  readonly userId: string;
  readonly paths: readonly string[];
  readonly source: ChangeSource;
  readonly hub: RunEventHub;
  readonly timings?: Partial<StreamTimings>;
  /** Wait after a hint before reading, so a burst of commits is read once (ms). */
  readonly debounceMs?: number;
  /** Called exactly once when the stream ends (frees the user's slot). */
  readonly onEnd?: () => void;
  /** Tears down the connection of a client that stopped reading (see run streams). */
  readonly abortConnection?: (() => void) | undefined;
}

export const CHANGE_DEBOUNCE_MS = 250;

const encoder = new TextEncoder();

export function createWorkspaceChangeStream(input: ChangeStreamInput): ReadableStream<Uint8Array> {
  const t = { ...STREAM_DEFAULTS, ...input.timings };
  const debounceMs = input.debounceMs ?? CHANGE_DEBOUNCE_MS;
  const log = rootLogger.child({ component: "workspace-change-stream" });
  let lastRev = 0;
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
      log.info("dropping stalled workspace change stream; it reconnects and catches up");
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
        if (!(await input.source.revalidate())) {
          endRequested = true;
          continue;
        }
      }
      if (dirty) {
        dirty = false;
        lastReadAt = Date.now();
        const rows = await input.source.read(first ? 0 : lastRev);
        if (ended) return;
        const type = first ? "file.state" : "file.changed";
        const out = first ? snapshotOf(input.paths, rows) : rows;
        first = false;
        let text = "";
        for (const change of out) {
          text += formatWorkspaceChange(type, change);
          lastRev = Math.max(lastRev, change.rev);
        }
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
        log.warn({ err }, "workspace change stream read failed; closing for client resume");
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

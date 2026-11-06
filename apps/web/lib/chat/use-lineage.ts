"use client";

import type { ThreadLineageResponse } from "@kobe/protocol";
import { LINEAGE_REREAD_MS } from "./lineage";
import { useFocusReread } from "./use-focus-reread";

/** What the hook needs of the chat session: the read and the signals that make it stale. */
export interface LineageSource {
  readonly api: {
    readonly threadLineage: (threadId: string) => Promise<ThreadLineageResponse | null>;
  };
  /** A thread was created here, a fork among them (the fork dialog's success). */
  readonly onThreadCreated: (listener: () => void) => () => void;
  /** A thread went to Trash, came back or was deleted forever from the Threads panel. */
  readonly onThreadTrashChanged: (listener: () => void) => () => void;
}

const readLineage = (source: LineageSource, threadId: string) => source.api.threadLineage(threadId);

const lineageSignals = (source: LineageSource, reread: () => void) => {
  const offCreated = source.onThreadCreated(reread);
  const offTrash = source.onThreadTrashChanged(reread);
  return () => {
    offCreated();
    offTrash();
  };
};

/**
 * The lineage of the thread on screen (TL4, KOBE-535): read when the thread opens, after a fork,
 * after a thread is trashed or restored from the panel, and on window focus once the last read is
 * older than `LINEAGE_REREAD_MS` (or failed). Never stored, never pushed. A failed read is null
 * (the strip shows nothing) and the next trigger tries again. A late answer for a thread no longer
 * on screen, or overtaken by a newer read, is dropped.
 */
export function useLineage(
  threadId: string | null,
  source: LineageSource | null,
  now: () => number = Date.now,
): ThreadLineageResponse | null {
  const { value } = useFocusReread(threadId, source, readLineage, {
    rereadMs: LINEAGE_REREAD_MS,
    now,
    subscribe: lineageSignals,
  });
  return value?.thread_id === threadId ? value : null;
}

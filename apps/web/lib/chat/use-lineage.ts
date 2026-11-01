"use client";

import { useEffect, useRef, useState } from "react";
import type { ThreadLineageResponse } from "@kobe/protocol";
import { LINEAGE_REREAD_MS } from "./lineage";

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
  const [lineage, setLineage] = useState<ThreadLineageResponse | null>(null);
  const last = useRef<{ at: number; ok: boolean } | null>(null);
  const nowRef = useRef(now);
  nowRef.current = now;

  useEffect(() => {
    setLineage(null);
    last.current = null;
    if (threadId === null || source === null) return;
    let alive = true;
    let seq = 0;
    const read = () => {
      const mine = ++seq;
      void source.api.threadLineage(threadId).then((answer) => {
        if (!alive || mine !== seq) return;
        last.current = { at: nowRef.current(), ok: answer !== null };
        setLineage(answer);
      });
    };
    const onFocus = () => {
      const prev = last.current;
      if (prev === null || !prev.ok || nowRef.current() - prev.at >= LINEAGE_REREAD_MS) read();
    };
    read();
    const offCreated = source.onThreadCreated(read);
    const offTrash = source.onThreadTrashChanged(read);
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      offCreated();
      offTrash();
      window.removeEventListener("focus", onFocus);
    };
  }, [threadId, source]);

  return lineage?.thread_id === threadId ? lineage : null;
}

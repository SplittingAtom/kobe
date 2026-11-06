"use client";

/**
 * The `branches` read of the thread on screen (CT2, KOBE-545), with the lineage's triggers (TL4):
 * when the thread opens and on window focus once the last read is older than
 * {@link BRANCHES_REREAD_MS} (or failed), plus after a label change (`refresh`). Never stored,
 * never pushed. A failed read is empty notes: the tree shows no labels and no rule badges, and no
 * error box. A late answer for a thread no longer on screen, or overtaken by a newer read, is
 * dropped. `source` must be stable (the chat session).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadBranchesResponse } from "@kobe/protocol";
import { BRANCHES_REREAD_MS, EMPTY_BRANCHES } from "./branches";

export interface BranchesSource {
  readonly api: {
    readonly getThreadBranches: (threadId: string) => Promise<ThreadBranchesResponse | null>;
  };
}

export interface Branches {
  /** The last good read for the thread on screen, else empty. */
  readonly notes: ThreadBranchesResponse;
  /** Read again now (after a label change). */
  readonly refresh: () => void;
  /** The answer of a label write (CT9, KOBE-546): the store is that body, no read again. */
  readonly replace: (notes: ThreadBranchesResponse) => void;
}

export function useBranches(
  threadId: string | null,
  source: BranchesSource | null,
  now: () => number = Date.now,
): Branches {
  const [state, setState] = useState<{ id: string; notes: ThreadBranchesResponse } | null>(null);
  const last = useRef<{ at: number; ok: boolean } | null>(null);
  const reader = useRef<() => void>(() => {});
  const seq = useRef(0);
  const nowRef = useRef(now);
  nowRef.current = now;

  useEffect(() => {
    setState(null);
    last.current = null;
    reader.current = () => {};
    if (threadId === null || source === null) return;
    let alive = true;
    const read = () => {
      const mine = ++seq.current;
      void source.api.getThreadBranches(threadId).then((answer) => {
        if (!alive || mine !== seq.current) return;
        last.current = { at: nowRef.current(), ok: answer !== null };
        setState(answer === null ? null : { id: threadId, notes: answer });
      });
    };
    const onFocus = () => {
      const prev = last.current;
      if (prev === null || !prev.ok || nowRef.current() - prev.at >= BRANCHES_REREAD_MS) read();
    };
    reader.current = read;
    read();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      reader.current = () => {};
      window.removeEventListener("focus", onFocus);
    };
  }, [threadId, source]);

  const refresh = useCallback(() => reader.current(), []);
  const replace = useCallback(
    (notes: ThreadBranchesResponse) => {
      if (threadId === null) return;
      // A read still on its way is older than this answer: it must not overwrite it.
      seq.current += 1;
      last.current = { at: nowRef.current(), ok: true };
      setState({ id: threadId, notes });
    },
    [threadId],
  );
  const notes = state !== null && state.id === threadId ? state.notes : EMPTY_BRANCHES;
  return { notes, refresh, replace };
}

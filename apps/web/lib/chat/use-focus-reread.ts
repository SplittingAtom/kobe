"use client";

/**
 * A per-thread read with TL4's triggers (shared by the lineage strip and the Conversation tree's
 * `branches` read): when the thread opens, on window focus once the last read is older than
 * `rereadMs` (or failed), on the extra signals `subscribe` names, and on `refresh()`. Never stored,
 * never pushed. A late answer for a thread no longer on screen, or overtaken by a newer read, is
 * dropped. A failed read clears the value, or keeps the last good one with `keepOnFailure`.
 * `source` must be stable (the chat session); `read` and `subscribe` may change per render.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface FocusRereadOptions<S> {
  readonly rereadMs: number;
  readonly now?: (() => number) | undefined;
  /** Other signals that make the value stale; returns the unsubscribe. */
  readonly subscribe?: ((source: S, reread: () => void) => () => void) | undefined;
  readonly keepOnFailure?: boolean | undefined;
}

export function useFocusReread<S, T>(
  threadId: string | null,
  source: S | null,
  read: (source: S, threadId: string) => Promise<T | null>,
  options: FocusRereadOptions<S>,
): { readonly value: T | null; readonly refresh: () => void } {
  const [state, setState] = useState<{ id: string; value: T } | null>(null);
  const last = useRef<{ at: number; ok: boolean } | null>(null);
  const reader = useRef<() => void>(() => {});
  const latest = useRef({ read, options });
  latest.current = { read, options };

  useEffect(() => {
    const now = () => (latest.current.options.now ?? Date.now)();
    setState(null);
    last.current = null;
    reader.current = () => {};
    if (threadId === null || source === null) return;
    let alive = true;
    let seq = 0;
    const reread = () => {
      const mine = ++seq;
      void latest.current.read(source, threadId).then((answer) => {
        if (!alive || mine !== seq) return;
        last.current = { at: now(), ok: answer !== null };
        if (answer !== null) setState({ id: threadId, value: answer });
        else if (latest.current.options.keepOnFailure !== true) setState(null);
      });
    };
    const onFocus = () => {
      const prev = last.current;
      if (prev === null || !prev.ok || now() - prev.at >= latest.current.options.rereadMs) reread();
    };
    reader.current = reread;
    reread();
    const off = latest.current.options.subscribe?.(source, reread);
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      reader.current = () => {};
      off?.();
      window.removeEventListener("focus", onFocus);
    };
  }, [threadId, source]);

  const refresh = useCallback(() => reader.current(), []);
  return { value: state !== null && state.id === threadId ? state.value : null, refresh };
}

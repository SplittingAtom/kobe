"use client";

import { createContext, useContext, useEffect, useState } from "react";

/**
 * The thread the chat app is opening or showing (its address), before the runtime's state names
 * it: on load the runtime first shows a new conversation, then switches to the thread asked for.
 * Null: a new conversation. Undefined: no chat app around (nothing to wait for).
 */
export const ThreadOnScreenContext = createContext<string | null | undefined>(undefined);

/** How long a picker's opening waits for the thread asked for (review MEDIUM-2). */
export const THREAD_SETTLE_MS = 3_000;

/**
 * Whether the runtime's thread is the one the chat app asked for (KOBE-460: a picker's opening).
 * A thread that never loads (deleted, another team's) stops the wait after `waitMs`: the caller
 * then goes with the thread the runtime shows (none, in a new conversation).
 */
export function useThreadSettled(
  runtimeThreadId: string | null,
  waitMs = THREAD_SETTLE_MS,
): boolean {
  const wanted = useContext(ThreadOnScreenContext);
  const matches = wanted === undefined || wanted === runtimeThreadId;
  const key = `${wanted ?? ""}|${runtimeThreadId ?? ""}`;
  const [expired, setExpired] = useState<string | null>(null);
  useEffect(() => {
    if (matches) return;
    const timer = setTimeout(() => setExpired(key), waitMs);
    return () => clearTimeout(timer);
  }, [matches, key, waitMs]);
  return matches || expired === key;
}

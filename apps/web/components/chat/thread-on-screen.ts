"use client";

import { createContext, useContext } from "react";

/**
 * The thread the chat app is opening or showing (its address), before the runtime's state names
 * it: on load the runtime first shows a new conversation, then switches to the thread asked for.
 * Null: a new conversation. Undefined: no chat app around (nothing to wait for).
 */
export const ThreadOnScreenContext = createContext<string | null | undefined>(undefined);

/** Whether the runtime's thread is the one the chat app asked for (KOBE-460: a picker's opening). */
export function useThreadSettled(runtimeThreadId: string | null): boolean {
  const wanted = useContext(ThreadOnScreenContext);
  return wanted === undefined || wanted === runtimeThreadId;
}

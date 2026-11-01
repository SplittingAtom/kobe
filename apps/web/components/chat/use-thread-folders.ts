"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { FoldersState } from "../../lib/chat/folders-store";
import { useChatSession } from "./kobe-runtime";

/** The team's folders as this tab last read them (KOBE-536); `read` asks once if none yet. */
export function useThreadFolders(read = false): FoldersState {
  const session = useChatSession();
  const store = session.folders;
  useEffect(() => {
    if (read) store.ensure();
  }, [store, read]);
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** Reads the folders now and whenever the window regains focus (TF7: no push). */
export function useFolderReads(): void {
  const session = useChatSession();
  const store = session.folders;
  useEffect(() => {
    void store.refresh();
    const onFocus = () => void store.refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [store]);
}

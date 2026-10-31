"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  activateTab,
  addTab,
  closeTab as closeTabIn,
  NO_TABS,
  openTab,
  readTabs,
  retainTabs,
  retargetFileTabs,
  writeTabs,
  type ArtifactTabs,
} from "../../lib/chat/artifact-tabs";

export interface OpenRequest {
  readonly id: string;
  /** A specific version, applied when the request opens the tab; absent = the latest. */
  readonly version: number | undefined;
  /** Distinguishes two requests for the same artifact (the column takes focus again). */
  readonly seq: number;
}

export interface ArtifactTabsApi {
  readonly tabs: ArtifactTabs;
  /** The member's last open request (null after a thread switch). */
  readonly request: OpenRequest | null;
  /** The member opens an artifact: its tab becomes active and the column takes focus. */
  openArtifact(id: string, version?: number): void;
  /** The agent created one: it opens and becomes active, focus stays where it is. */
  autoOpen(id: string): void;
  /** Opens a tab beside the others; it becomes active only when none is (KOBE-531). */
  add(id: string): void;
  activate(id: string): void;
  closeTab(id: string): void;
  /** Closes the active tab. */
  close(): void;
  /** Drops tabs of artifacts the thread no longer lists. */
  prune(existing: ReadonlySet<string>): void;
  /** Drops one tab whose content is gone (a deleted file); focus as `closeTab` when it was there. */
  drop(id: string): void;
  /** A workspace file or folder moved: its file tabs follow (KOBE-304). */
  retargetFiles(from: string, to: string): void;
}

/** The shell's artifact column (`components/shell/shell-grid.tsx`). */
const ARTIFACT_COLUMN_ID = "kobe-artifact-column";

/** Where focus goes when the last tab closes and nothing that opened the column is left. */
function focusConversation(): void {
  document.getElementById("kobe-chat-main")?.focus();
}

/**
 * The tabs of the thread under `key` (null: a new conversation, nothing remembered): restored
 * from and remembered in localStorage, swapped when the key changes, except when `conversation`
 * (assistant-ui's thread item id) stays the same: a new conversation got its thread id. Every change is a functional
 * update, so updates queued in one tick (an auto-open and a close) all apply.
 */
export function useArtifactTabs(key: string | null, conversation?: string): ArtifactTabsApi {
  const [tabs, setTabs] = useState<ArtifactTabs>(() => (key === null ? NO_TABS : readTabs(key)));
  const [request, setRequest] = useState<OpenRequest | null>(null);
  const [seen, setSeen] = useState({ key, conversation });
  if (seen.key !== key || seen.conversation !== conversation) {
    setSeen({ key, conversation });
    // A new conversation that just became a thread (same conversation, first key) keeps its tabs:
    // they are remembered under the new key from now on.
    const adopted =
      seen.key === null &&
      key !== null &&
      conversation !== undefined &&
      seen.conversation === conversation;
    if (!adopted) {
      setTabs(key === null ? NO_TABS : readTabs(key));
      setRequest(null);
    }
  }
  useEffect(() => {
    if (key !== null) writeTabs(key, tabs);
  }, [key, tabs]);

  const opener = useRef<Element | null>(null);
  const seq = useRef(0);
  /** A close by the member is pending: once the column is gone, focus moves out of it. */
  const closing = useRef(false);
  const empty = tabs.open.length === 0;
  useEffect(() => {
    if (!closing.current) return;
    closing.current = false;
    if (!empty) return;
    const back = opener.current;
    opener.current = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
    else focusConversation();
  }, [tabs, empty]);

  const openArtifact = useCallback((id: string, version?: number) => {
    opener.current = document.activeElement;
    seq.current += 1;
    setRequest({ id, version, seq: seq.current });
    setTabs((prev) => openTab(prev, id));
  }, []);
  const autoOpen = useCallback((id: string) => setTabs((prev) => openTab(prev, id)), []);
  const add = useCallback((id: string) => setTabs((prev) => addTab(prev, id)), []);
  const activate = useCallback((id: string) => setTabs((prev) => activateTab(prev, id)), []);
  const closeTab = useCallback((id: string) => {
    closing.current = true;
    setTabs((prev) => closeTabIn(prev, id));
    setRequest((prev) => (prev?.id === id ? null : prev));
  }, []);
  const close = useCallback(() => {
    closing.current = true;
    setTabs((prev) => (prev.active === null ? prev : closeTabIn(prev, prev.active)));
    setRequest(null);
  }, []);
  const prune = useCallback(
    (existing: ReadonlySet<string>) => setTabs((prev) => retainTabs(prev, existing)),
    [],
  );
  /** Like closeTab, but focus moves only if it was in the column (or lost): a restore may drop. */
  const drop = useCallback((id: string) => {
    const active = document.activeElement;
    const column = document.getElementById(ARTIFACT_COLUMN_ID);
    closing.current = active === null || active === document.body || !!column?.contains(active);
    setTabs((prev) => closeTabIn(prev, id));
    setRequest((prev) => (prev?.id === id ? null : prev));
  }, []);
  const retargetFiles = useCallback((from: string, to: string) => {
    setTabs((prev) => retargetFileTabs(prev, from, to));
    setRequest((prev) => {
      if (prev === null) return prev;
      const id = retargetFileTabs({ open: [prev.id], active: prev.id }, from, to).active;
      return id === null || id === prev.id ? prev : { ...prev, id };
    });
  }, []);
  return {
    tabs,
    request,
    openArtifact,
    autoOpen,
    add,
    activate,
    closeTab,
    close,
    prune,
    drop,
    retargetFiles,
  };
}

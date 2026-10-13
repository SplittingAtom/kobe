"use client";

/**
 * The artifact column's state (CE6, KOBE-200; the panel itself is KOBE-130): the tabs open in the
 * thread on screen, which one is active, the thread's artifacts and the column's width.
 *
 * - Tabs are in order of opening; artifacts the agent creates during a run open by themselves and
 *   become active (without taking focus from the member).
 * - The open set and active tab are remembered per thread in this browser (localStorage); a
 *   thread switch swaps them, and tabs of artifacts the thread no longer lists are dropped.
 * - Slot (A6, KOBE-202): CE8 keeps the column's width per user, server-side. Until A6 loads and
 *   saves it here, a dragged width lives in memory for the page's lifetime.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  activateTab,
  closeTab as closeTabIn,
  NO_TABS,
  openTab,
  readTabs,
  retainTabs,
  tabsKey,
  writeTabs,
  type ArtifactTabs,
} from "../../lib/chat/artifact-tabs";
import type { ArtifactSummaryView } from "../../lib/chat/artifacts";
import type { LiveRun } from "../../lib/chat/live";
import { useChatSession, useKobeExtras } from "./kobe-runtime";

export interface OpenRequest {
  readonly id: string;
  /** A specific version; absent = the latest, following updates. */
  readonly version: number | undefined;
  /** Distinguishes two requests for the same artifact, so a click resets the version. */
  readonly seq: number;
}

export interface ArtifactPanelApi {
  /** The active tab's artifact. */
  readonly openId: string | null;
  readonly tabs: ArtifactTabs;
  /** The thread's artifacts; null while they load or when the list could not be read. */
  readonly artifacts: readonly ArtifactSummaryView[] | null;
  /** The column's dragged width in px; null is the default (half the space right of the rail). */
  readonly width: number | null;
  /** The member opens an artifact: its tab becomes active and the column takes focus. */
  openArtifact(id: string, version?: number): void;
  activate(id: string): void;
  closeTab(id: string): void;
  /** Closes the active tab. */
  close(): void;
  setWidth(width: number): void;
}

const ArtifactPanelContext = createContext<ArtifactPanelApi | null>(null);
export const ArtifactPanelRequest = createContext<OpenRequest | null>(null);

/** Null outside a provider (slots rendered on their own show no Open button). */
export function useArtifactPanel(): ArtifactPanelApi | null {
  return useContext(ArtifactPanelContext);
}

/** Artifact events seen on the live run: a change means the list or the open artifact moved on. */
export function useArtifactEventCount(): number {
  const live = useKobeExtras()?.state.live;
  if (!live) return 0;
  const onTools = Object.values(live.tools).reduce((n, t) => n + t.artifacts.length, 0);
  const notices = live.notices.filter(
    (n) => n.type === "artifact.created" || n.type === "artifact.updated",
  ).length;
  return onTools + notices;
}

/** Artifacts the live run created (version 1), on tool calls or as run notices. */
function createdOn(live: LiveRun | undefined): readonly string[] {
  if (!live) return [];
  const onTools = Object.values(live.tools).flatMap((t) =>
    t.artifacts.filter((a) => a.version === 1).map((a) => a.artifact_id),
  );
  const notices = live.notices.flatMap((n) =>
    n.type === "artifact.created" ? [n.payload.artifact_id] : [],
  );
  return [...onTools, ...notices];
}

/** Calls `onCreated` once per artifact the agent creates in `threadId` while it is on screen. */
function useAgentCreated(threadId: string | undefined, onCreated: (id: string) => void): void {
  const state = useKobeExtras()?.state;
  const created = useMemo(() => createdOn(state?.live), [state?.live]);
  const sameThread = threadId !== undefined && state?.threadId === threadId;
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!sameThread) return;
    for (const id of created) {
      if (seen.current.has(id)) continue;
      seen.current.add(id);
      onCreated(id);
    }
  }, [created, sameThread, onCreated]);
}

interface ThreadList {
  readonly threadId: string;
  readonly artifacts: readonly ArtifactSummaryView[] | null;
}

/** The thread's artifacts, read again when the live run reports one; drops tabs of gone ones. */
function useThreadArtifacts(
  threadId: string | undefined,
  prune: (existing: ReadonlySet<string>) => void,
): readonly ArtifactSummaryView[] | null {
  const session = useChatSession();
  const events = useArtifactEventCount();
  const [list, setList] = useState<ThreadList | null>(null);
  useEffect(() => {
    if (threadId === undefined) return;
    let current = true;
    void session.api.listArtifacts(threadId).then((res) => {
      if (!current) return;
      // A failed list keeps the tabs: the notice and tool card still open artifacts.
      setList({ threadId, artifacts: res.ok ? res.data.artifacts : null });
      if (res.ok) prune(new Set(res.data.artifacts.map((a) => a.id)));
    });
    return () => {
      current = false;
    };
  }, [session, threadId, events, prune]);
  // Never another thread's artifacts while this one's load.
  return list !== null && list.threadId === threadId ? list.artifacts : null;
}

export function ArtifactPanelProvider({
  teamId,
  threadId,
  children,
}: {
  readonly teamId: string;
  /** The thread on screen; undefined for a new conversation (nothing to remember yet). */
  readonly threadId: string | undefined;
  readonly children: ReactNode;
}) {
  const key = threadId === undefined ? null : tabsKey(teamId, threadId);
  const [tabs, setTabs] = useState<ArtifactTabs>(() => (key === null ? NO_TABS : readTabs(key)));
  const [request, setRequest] = useState<OpenRequest | null>(null);
  const [seenKey, setSeenKey] = useState(key);
  if (seenKey !== key) {
    setSeenKey(key);
    setTabs(key === null ? NO_TABS : readTabs(key));
    setRequest(null);
  }
  useEffect(() => {
    if (key !== null) writeTabs(key, tabs);
  }, [key, tabs]);
  // Slot (A6, KOBE-202): load and save the width per user here.
  const [width, setWidth] = useState<number | null>(null);

  const tabsNow = useRef(tabs);
  tabsNow.current = tabs;
  const opener = useRef<Element | null>(null);
  const seq = useRef(0);

  const openArtifact = useCallback((id: string, version?: number) => {
    opener.current = document.activeElement;
    seq.current += 1;
    setRequest({ id, version, seq: seq.current });
    setTabs((prev) => openTab(prev, id));
  }, []);
  const autoOpen = useCallback((id: string) => setTabs((prev) => openTab(prev, id)), []);
  const activate = useCallback((id: string) => setTabs((prev) => activateTab(prev, id)), []);
  const closeTab = useCallback((id: string) => {
    const next = closeTabIn(tabsNow.current, id);
    setTabs(next);
    setRequest((prev) => (prev?.id === id ? null : prev));
    if (next.open.length > 0) return;
    // The column is gone: focus goes back to what opened it.
    const back = opener.current;
    opener.current = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  }, []);
  const close = useCallback(() => {
    const active = tabsNow.current.active;
    if (active !== null) closeTab(active);
  }, [closeTab]);
  const prune = useCallback(
    (existing: ReadonlySet<string>) => setTabs((prev) => retainTabs(prev, existing)),
    [],
  );

  useAgentCreated(threadId, autoOpen);
  const artifacts = useThreadArtifacts(threadId, prune);

  const api = useMemo<ArtifactPanelApi>(
    () => ({
      openId: tabs.active,
      tabs,
      artifacts,
      width,
      openArtifact,
      activate,
      closeTab,
      close,
      setWidth,
    }),
    [tabs, artifacts, width, openArtifact, activate, closeTab, close],
  );
  return (
    <ArtifactPanelContext.Provider value={api}>
      <ArtifactPanelRequest.Provider value={request}>{children}</ArtifactPanelRequest.Provider>
    </ArtifactPanelContext.Provider>
  );
}

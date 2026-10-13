"use client";

/**
 * The artifact column's state (CE6, KOBE-200; the panel itself is KOBE-130): the tabs open in the
 * thread on screen, which one is active, the thread's artifacts and the column's width.
 *
 * - Tabs are in order of opening; artifacts the agent creates during a run open by themselves and
 *   become active (without taking focus from the member).
 * - The open set and active tab are remembered per thread in this browser (localStorage,
 *   `use-artifact-tabs.ts`); a thread switch swaps them, and tabs of artifacts the thread no
 *   longer lists are dropped.
 * - The column's width is per user, server-side (CE8, KOBE-202, `lib/shell/preferences.ts`): the
 *   stored width applies once it loads if it still fits this window beside the conversation's
 *   floor (else the default, half the space), and a resize is saved when it is released.
 * - Under 820 px the column is a sheet (CE7, CE8, KOBE-201): it shows when the member opens an
 *   artifact and hides with Back, keeping the tabs; the agent's new artifacts join the tabs
 *   without covering the conversation. The width is neither applied nor saved there.
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
import { useAuiState } from "@assistant-ui/react";
import { tabsKey, type ArtifactTabs } from "../../lib/chat/artifact-tabs";
import type { ArtifactSummaryView } from "../../lib/chat/artifacts";
import type { LiveRun } from "../../lib/chat/live";
import {
  applyArtifactWidth,
  holdsBothFloors,
  shellGrid,
  spaceRightOfRail,
  useStoredPreference,
  type LayoutPreferences,
} from "../../lib/shell/preferences";
import { artifactAsSheet } from "../../lib/shell/layout";
import { useRail } from "../shell/rail-state";
import { useShellBand } from "../shell/shell-band";
import { useChatSession, type KobeThreadExtras } from "./kobe-runtime";
import { useArtifactTabs, type OpenRequest } from "./use-artifact-tabs";

export type { OpenRequest };

export interface ArtifactPanelApi {
  /** The active tab's artifact. */
  readonly openId: string | null;
  readonly tabs: ArtifactTabs;
  /** The thread's artifacts; null while they load or when the list could not be read. */
  readonly artifacts: readonly ArtifactSummaryView[] | null;
  /** Titles the run announced (`artifact.created`), for tabs the list doesn't have yet. */
  readonly createdTitles: Readonly<Record<string, string>>;
  /** The column's dragged width in px; null is the default (half the space right of the rail). */
  readonly width: number | null;
  /** Under 820 px: the artifact sheet is showing (the member opened an artifact). Else false. */
  readonly sheetOpen: boolean;
  /** Back to the conversation: hides the sheet, keeps the tabs. */
  hideSheet(): void;
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

interface ArtifactEvent {
  readonly artifact_id: string;
  readonly version: number;
  readonly title?: string | undefined;
}

/** The live run's artifact events, on tool calls and as run notices. */
function artifactEvents(live: LiveRun | undefined): readonly ArtifactEvent[] {
  if (!live) return [];
  const notices = live.notices.flatMap((n) =>
    n.type === "artifact.created" || n.type === "artifact.updated" ? [n.payload] : [],
  );
  return [...Object.values(live.tools).flatMap((t) => t.artifacts), ...notices];
}

const liveOf = (extras: unknown) => (extras as KobeThreadExtras | undefined)?.state.live;

/**
 * Artifact events seen on the live run (of `id` only, when given): a change means the list or
 * that artifact moved on. A number, so streamed text deltas don't re-render the caller.
 */
export function useArtifactEventCount(id?: string): number {
  return useAuiState(
    (s) =>
      artifactEvents(liveOf(s.thread.extras)).filter(
        (e) => id === undefined || e.artifact_id === id,
      ).length,
  );
}

/**
 * Artifacts the agent created (version 1) on the live run of `threadId`, as a stable string of
 * `id\ttitle` lines, so the caller re-renders only when one is added.
 */
function useCreatedOn(threadId: string | undefined): string {
  return useAuiState((s) => {
    const extras = s.thread.extras as KobeThreadExtras | undefined;
    if (threadId === undefined || extras?.state.threadId !== threadId) return "";
    return artifactEvents(extras.state.live)
      .filter((e) => e.version === 1)
      .map((e) => `${e.artifact_id}\t${e.title ?? ""}`)
      .join("\n");
  });
}

/** Opens each artifact the agent creates in `threadId` once; returns the titles it announced. */
function useAgentCreated(
  threadId: string | undefined,
  onCreated: (id: string) => void,
): Readonly<Record<string, string>> {
  const created = useCreatedOn(threadId);
  const seen = useRef(new Set<string>());
  const entries = useMemo(
    () =>
      created === "" ? [] : created.split("\n").map((line) => line.split("\t") as [string, string]),
    [created],
  );
  useEffect(() => {
    for (const [id] of entries) {
      if (seen.current.has(id)) continue;
      seen.current.add(id);
      onCreated(id);
    }
  }, [entries, onCreated]);
  return useMemo(() => Object.fromEntries(entries.filter(([, t]) => t !== "")), [entries]);
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

/**
 * The column's width: the member's stored width, applied once the rail on screen is settled if it
 * fits the space right of it (measured), and saved on release. A width chosen on a narrow screen,
 * or where the two floors don't both fit, stays on this page (it would not fit elsewhere).
 */
function useArtifactWidth(
  preferences: LayoutPreferences | null,
  onSave: ((change: LayoutPreferences) => void) | undefined,
) {
  const rail = useRail();
  // A sheet has no column to measure: the stored width waits for a window with one.
  const sheet = artifactAsSheet(useShellBand());
  const width = useStoredPreference<number | null>({
    initial: null,
    ready: preferences !== null && (rail === null || rail.settled) && !sheet,
    resolve: () => {
      const space = spaceRightOfRail(shellGrid());
      return space === null ? null : applyArtifactWidth(preferences?.artifactWidth, space);
    },
    save: onSave && ((artifactWidth) => onSave({ artifactWidth })),
  });
  const { set, commit } = width;
  const setWidth = useCallback(
    (next: number) => {
      const space = spaceRightOfRail(shellGrid());
      const local = sheet || (space !== null && !holdsBothFloors(space));
      return local ? set(next) : commit(next);
    },
    [sheet, set, commit],
  );
  return [width.value, setWidth] as const;
}

/**
 * Whether the artifact sheet shows (under 820 px): from the member's open until Back, the last
 * tab closing or a thread switch. The agent's auto-opens never show it.
 */
function useSheet(threadId: string | undefined, hasTabs: boolean) {
  const [state, setState] = useState({ open: false, threadId });
  if (state.threadId !== threadId || (state.open && !hasTabs)) {
    setState({ open: false, threadId });
  }
  const show = useCallback(() => setState({ open: true, threadId }), [threadId]);
  const hide = useCallback(() => setState({ open: false, threadId }), [threadId]);
  const open = state.open && state.threadId === threadId && hasTabs;
  return useMemo(() => ({ open, show, hide }), [open, show, hide]);
}

export function ArtifactPanelProvider({
  teamId,
  threadId,
  preferences = null,
  onSavePreferences,
  children,
}: {
  readonly teamId: string;
  /** The thread on screen; undefined for a new conversation (nothing to remember yet). */
  readonly threadId: string | undefined;
  /** The member's stored layout (null while it loads). */
  readonly preferences?: LayoutPreferences | null;
  /** Saves a width the member chose (debounced by the caller). */
  readonly onSavePreferences?: (change: LayoutPreferences) => void;
  readonly children: ReactNode;
}) {
  const t = useArtifactTabs(threadId === undefined ? null : tabsKey(teamId, threadId));
  const [width, setWidth] = useArtifactWidth(preferences, onSavePreferences);
  const createdTitles = useAgentCreated(threadId, t.autoOpen);
  const artifacts = useThreadArtifacts(threadId, t.prune);
  const sheet = useSheet(threadId, t.tabs.active !== null);
  const asSheet = artifactAsSheet(useShellBand());
  const { openArtifact: openTab } = t;
  const openArtifact = useCallback(
    (id: string, version?: number) => {
      sheet.show();
      openTab(id, version);
    },
    [sheet, openTab],
  );

  const api = useMemo<ArtifactPanelApi>(
    () => ({
      openId: t.tabs.active,
      tabs: t.tabs,
      artifacts,
      createdTitles,
      width,
      sheetOpen: asSheet && sheet.open,
      hideSheet: sheet.hide,
      openArtifact,
      activate: t.activate,
      closeTab: t.closeTab,
      close: t.close,
      setWidth,
    }),
    [
      t.tabs,
      artifacts,
      createdTitles,
      width,
      setWidth,
      asSheet,
      sheet.open,
      sheet.hide,
      openArtifact,
      t.activate,
      t.closeTab,
      t.close,
    ],
  );
  return (
    <ArtifactPanelContext.Provider value={api}>
      <ArtifactPanelRequest.Provider value={t.request}>{children}</ArtifactPanelRequest.Provider>
    </ArtifactPanelContext.Provider>
  );
}

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
 * - Workspace files open as tabs too (KOBE-268, `lib/files/preview.ts`: `file:<path>` ids, so they
 *   never collide with artifact ids); one whose file is gone is dropped with a notice.
 * - The files the agent wrote in the thread (KOBE-488, `GET /v1/threads/{id}/files`) are listed
 *   beside its artifacts, for the badge row under the title.
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
import type { FileEntry } from "../../lib/files/api";
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
import { fileTabId } from "../../lib/files/preview";
import { appTabId, isAppTab, type AppTabSpec } from "../../lib/apps/app-tabs";
import { useRail } from "../shell/rail-state";
import { useShellBand } from "../shell/shell-band";
import { kobeExtrasOf, useChatSession } from "./kobe-runtime";
import { useArtifactTabs, type OpenRequest } from "./use-artifact-tabs";
import { useThreadFiles } from "./use-thread-files";

export type { OpenRequest };

export interface ArtifactPanelApi {
  /** The active tab's artifact. */
  readonly openId: string | null;
  readonly tabs: ArtifactTabs;
  /** The thread's artifacts; null while they load or when the list could not be read. */
  readonly artifacts: readonly ArtifactSummaryView[] | null;
  /**
   * Workspace files the agent wrote in the thread (KOBE-488), first written first; empty while they
   * load, when the list could not be read, and for anyone but the thread's owner.
   */
  readonly files: readonly FileEntry[];
  /** Titles the run announced (`artifact.created`), for tabs the list doesn't have yet. */
  readonly createdTitles: Readonly<Record<string, string>>;
  /** The column's dragged width in px; null is the default (half the space right of the rail). */
  readonly width: number | null;
  /** Under 820 px: the artifact sheet is showing (the member opened one there). Else false. */
  readonly sheetOpen: boolean;
  /** Back to the conversation: hides the sheet, keeps the tabs. */
  hideSheet(): void;
  /** The member opens an artifact: its tab becomes active and the column takes focus. */
  openArtifact(id: string, version?: number): void;
  /** The member opens a workspace file (KOBE-268): like an artifact, keyed by its path. */
  openFile(path: string): void;
  /**
   * Opens a workspace file's tab by itself (KOBE-489: a proposed edit with auto-open on): the tab
   * opens and becomes active, the column shows if hidden, focus stays where it is.
   */
  autoOpenFile(path: string): void;
  /** The file's tab closes: it is no longer in the workspace (`goneFile` names it). */
  dropFile(path: string): void;
  /**
   * A workspace file or folder moved or was renamed (KOBE-304): open file tabs of it follow, on
   * the thread on screen (tabs remembered on other threads find the file gone and say so).
   */
  moveFiles(from: string, to: string): void;
  /** The last file whose tab was dropped, until the member dismisses the notice. */
  readonly goneFile: string | null;
  dismissGone(): void;
  activate(id: string): void;
  closeTab(id: string): void;
  /** Closes the active tab. */
  close(): void;
  setWidth(width: number): void;
  /**
   * The member hid the column with its key or the palette (CE23, KOBE-225): its tabs stay and it
   * takes no space until shown again or an artifact is opened.
   */
  readonly hidden: boolean;
  /** Hides or shows the column (the sheet, under 820 px); false when there is nothing to show. */
  toggleColumn(): boolean;
  /**
   * MCP Apps (KOBE-438, spec MA3): expands a card's app into a transient `app` tab (or the sheet
   * under 820 px). Its card shows "Opened in the side column" until the tab closes.
   */
  openApp(spec: AppTabSpec): void;
  /** The open app tabs' specs, by tab id. */
  readonly appTabs: ReadonlyMap<string, AppTabSpec>;
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

/**
 * Artifact events seen on the live run (of `id` only, when given): a change means the list or
 * that artifact moved on. A number, so streamed text deltas don't re-render the caller.
 */
export function useArtifactEventCount(id?: string): number {
  return useAuiState(
    (s) =>
      artifactEvents(kobeExtrasOf(s)?.state.live).filter(
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
    const extras = kobeExtrasOf(s);
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
 * Whether the artifact sheet shows (under 820 px): from the member's open on a sheet width until
 * Back, the last tab closing, a thread switch or the window crossing 820 px. Opens on a column
 * width and the agent's auto-opens never show it, so narrowing the window never pops one up.
 */
function useSheet(threadId: string | undefined, hasTabs: boolean, asSheet: boolean) {
  const [state, setState] = useState({ open: false, threadId, asSheet });
  if (state.threadId !== threadId || state.asSheet !== asSheet || (state.open && !hasTabs)) {
    setState({ open: false, threadId, asSheet });
  }
  const show = useCallback(
    () => setState({ open: asSheet, threadId, asSheet }),
    [threadId, asSheet],
  );
  const hide = useCallback(() => setState({ open: false, threadId, asSheet }), [threadId, asSheet]);
  const open = state.open && state.threadId === threadId && state.asSheet === asSheet && hasTabs;
  return useMemo(() => ({ open, show, hide, asSheet }), [open, show, hide, asSheet]);
}

/** The thread's most recently updated artifact, to show when the column has no tab open. */
function newestArtifact(artifacts: readonly ArtifactSummaryView[] | null): string | undefined {
  const sorted = [...(artifacts ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sorted[0]?.id;
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
  // assistant-ui's id of the conversation on screen: unchanged when a new one gets its thread id.
  const conversation = useAuiState((s) => s.threadListItem.id);
  const t = useArtifactTabs(
    threadId === undefined ? null : tabsKey(teamId, threadId),
    conversation,
  );
  const [width, setWidth] = useArtifactWidth(preferences, onSavePreferences);
  const createdTitles = useAgentCreated(threadId, t.autoOpen);
  const artifacts = useThreadArtifacts(threadId, t.prune);
  const files = useThreadFiles(threadId);
  const sheet = useSheet(threadId, t.tabs.active !== null, artifactAsSheet(useShellBand()));
  const { openArtifact: openTab, drop, retargetFiles } = t;
  const editDrafts = useChatSession().editDrafts;
  // Unsaved edits follow a moved file (KOBE-463).
  const moveFiles = useCallback(
    (from: string, to: string) => {
      editDrafts.move(from, to);
      retargetFiles(from, to);
    },
    [editDrafts, retargetFiles],
  );
  const [hiddenIn, setHiddenIn] = useState<string | undefined | null>(null);
  // Hidden for the thread it was hidden on (`null`: shown); another thread shows its own tabs.
  const hidden = hiddenIn !== null && hiddenIn === threadId && !sheet.asSheet;
  const openArtifact = useCallback(
    (id: string, version?: number) => {
      setHiddenIn(null);
      sheet.show();
      openTab(id, version);
    },
    [sheet, openTab],
  );
  const hasTabs = t.tabs.active !== null;
  const newest = newestArtifact(artifacts);
  const toggleColumn = useCallback((): boolean => {
    if (sheet.asSheet) {
      if (sheet.open) sheet.hide();
      else if (hasTabs) sheet.show();
      else if (newest) openArtifact(newest);
      else return false;
      return true;
    }
    if (hasTabs) {
      setHiddenIn(hidden ? null : threadId);
      return true;
    }
    if (!newest) return false;
    openArtifact(newest);
    return true;
  }, [sheet, hasTabs, newest, openArtifact, hidden, threadId]);
  const openFile = useCallback((path: string) => openArtifact(fileTabId(path)), [openArtifact]);
  const autoOpenTab = t.autoOpen;
  const autoOpenFile = useCallback(
    (path: string) => {
      setHiddenIn(null);
      autoOpenTab(fileTabId(path));
    },
    [autoOpenTab],
  );
  const [appSpecs, setAppSpecs] = useState<ReadonlyMap<string, AppTabSpec>>(new Map());
  const openApp = useCallback(
    (spec: AppTabSpec) => {
      const id = appTabId(spec.cardKey);
      setAppSpecs((prev) => new Map(prev).set(id, spec));
      openArtifact(id);
    },
    [openArtifact],
  );
  // Only the tabs still open (a closed tab, or another thread's, has no spec).
  const openTabs = t.tabs.open;
  const appTabs = useMemo(
    () =>
      new Map([...appSpecs].filter(([id]) => isAppTab(id) && openTabs.includes(id))) as ReadonlyMap<
        string,
        AppTabSpec
      >,
    [appSpecs, openTabs],
  );
  const [gone, setGone] = useState<{ readonly path: string; readonly threadId?: string } | null>(
    null,
  );
  // The notice belongs to the thread it was raised on: another thread on screen clears it.
  const goneFile = gone !== null && gone.threadId === threadId ? gone.path : null;
  const dropFile = useCallback(
    (path: string) => {
      drop(fileTabId(path));
      editDrafts.clear(path);
      setGone(threadId === undefined ? { path } : { path, threadId });
    },
    [drop, threadId, editDrafts],
  );
  const dismissGone = useCallback(() => setGone(null), []);

  const api = useMemo<ArtifactPanelApi>(
    () => ({
      openId: t.tabs.active,
      tabs: t.tabs,
      artifacts,
      files,
      createdTitles,
      width,
      sheetOpen: sheet.open,
      hideSheet: sheet.hide,
      openArtifact,
      openFile,
      autoOpenFile,
      dropFile,
      moveFiles,
      goneFile,
      dismissGone,
      activate: t.activate,
      closeTab: t.closeTab,
      close: t.close,
      setWidth,
      hidden,
      toggleColumn,
      openApp,
      appTabs,
    }),
    [
      openApp,
      appTabs,
      hidden,
      toggleColumn,
      openFile,
      autoOpenFile,
      dropFile,
      moveFiles,
      goneFile,
      dismissGone,
      t.tabs,
      artifacts,
      files,
      createdTitles,
      width,
      setWidth,
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

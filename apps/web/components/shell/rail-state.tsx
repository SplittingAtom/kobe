"use client";

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
import { THREADS_SHARE_BOUNDS } from "@kobe/protocol";
import {
  applyRailCollapsed,
  applyThreadsShare,
  type LayoutPreferences,
} from "../../lib/shell/preferences";
import { IconAction } from "./icon-action";

/**
 * The workspace rail's state (CE5, KOBE-198): collapsed (48 px) or expanded (280 px), and the
 * share of the height the Threads section takes over Files.
 *
 * Both are per user, server-side (CE8, KOBE-202, `lib/shell/preferences.ts`): the provider applies
 * the stored values once they load (unless the member already changed that value on this page)
 * and saves the member's changes: a toggle, a divider release. Narrow screens keep the rail
 * collapsed whatever is stored, and their rail toggles are not saved (the drawer is per device).
 */
export type RailSection = "threads" | "files";

/** Threads' share of the rail's height: 60% by default, never squeezing either section out. */
export const THREADS_SHARE = {
  initial: 0.6,
  min: THREADS_SHARE_BOUNDS.min,
  max: THREADS_SHARE_BOUNDS.max,
  step: 0.05,
} as const;

/** Under the shell's one-column breakpoint the rail starts collapsed (A5 replaces this, CE8). */
const NARROW_QUERY = "(max-width: 47.99rem)";

export function isNarrowScreen(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(NARROW_QUERY).matches
    : false;
}

export function clampShare(share: number): number {
  if (!Number.isFinite(share)) return THREADS_SHARE.initial;
  const clamped = Math.min(THREADS_SHARE.max, Math.max(THREADS_SHARE.min, share));
  return round(clamped);
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The sections grid's rows for a Threads share: Threads, the divider, Files. */
export function sectionRows(share: number): string {
  return `minmax(0, ${round(share)}fr) auto minmax(0, ${round(1 - share)}fr)`;
}

export interface RailApi {
  readonly collapsed: boolean;
  readonly threadsShare: number;
  /** The section the member asked to see; the rail focuses it once rendered. */
  readonly revealed: { readonly section: RailSection; readonly seq: number } | null;
  setCollapsed(collapsed: boolean): void;
  setThreadsShare(share: number): void;
  /** Times the member asked for Files: 0 = not yet (nothing listed or woken); each ask re-wakes. */
  readonly filesRequests: number;
  /** Expands the rail and moves focus to a section (the collapsed icons, the bar's Files). */
  reveal(section: RailSection): void;
  /** Lists the workspace and wakes the sandbox (first use, Show files, refresh). */
  requestFiles(): void;
}

const RailContext = createContext<RailApi | null>(null);

export function useRail(): RailApi | null {
  return useContext(RailContext);
}

export function RailProvider({
  children,
  preferences = null,
  onSave,
}: {
  readonly children: ReactNode;
  /** The member's stored layout (null while it loads, or outside a signed-in shell). */
  readonly preferences?: LayoutPreferences | null;
  /** Saves a change the member made (debounced by the caller). */
  readonly onSave?: (change: LayoutPreferences) => void;
}) {
  // Expanded on the server and the first client render; narrow screens collapse after mount.
  const [collapsed, setCollapsedState] = useState(false);
  useEffect(() => {
    if (isNarrowScreen()) setCollapsedState(true);
  }, []);
  const [filesRequests, setFilesRequests] = useState(0);
  const requestFiles = useCallback(() => setFilesRequests((n) => n + 1), []);
  const [threadsShare, setShare] = useState<number>(THREADS_SHARE.initial);
  const [revealed, setRevealed] = useState<RailApi["revealed"]>(null);
  const save = useRef(onSave);
  useEffect(() => {
    save.current = onSave;
  }, [onSave]);
  const collapsedNow = useRef(collapsed);
  useEffect(() => {
    collapsedNow.current = collapsed;
  }, [collapsed]);
  /** Values the member changed on this page: stored values that load later don't override them. */
  const touched = useRef({ collapsed: false, share: false });
  const applied = useRef(false);
  useEffect(() => {
    if (preferences === null || applied.current) return;
    applied.current = true;
    const nextCollapsed = applyRailCollapsed(preferences.railCollapsed, isNarrowScreen());
    if (nextCollapsed !== null && !touched.current.collapsed) setCollapsedState(nextCollapsed);
    const nextShare = applyThreadsShare(preferences.threadsShare);
    if (nextShare !== null && !touched.current.share) setShare(nextShare);
  }, [preferences]);
  const setCollapsed = useCallback((next: boolean) => {
    touched.current.collapsed = true;
    setCollapsedState(next);
    // A phone's drawer is not the member's layout: only wide screens save the rail's state.
    if (!isNarrowScreen()) save.current?.({ railCollapsed: next });
  }, []);
  const setThreadsShare = useCallback((share: number) => {
    const next = clampShare(share);
    touched.current.share = true;
    setShare(next);
    save.current?.({ threadsShare: next });
  }, []);
  const reveal = useCallback(
    (section: RailSection) => {
      // Expanding a collapsed rail is a toggle (saved); an expanded one just moves focus.
      if (collapsedNow.current) setCollapsed(false);
      else setCollapsedState(false);
      setRevealed((prev) => ({ section, seq: (prev?.seq ?? 0) + 1 }));
      if (section === "files") setFilesRequests((n) => n + 1);
    },
    [setCollapsed],
  );
  const api = useMemo(
    () => ({
      collapsed,
      threadsShare,
      revealed,
      filesRequests,
      setCollapsed,
      setThreadsShare,
      reveal,
      requestFiles,
    }),
    [
      collapsed,
      threadsShare,
      revealed,
      filesRequests,
      setCollapsed,
      setThreadsShare,
      reveal,
      requestFiles,
    ],
  );
  return <RailContext.Provider value={api}>{children}</RailContext.Provider>;
}

/** Bar row two's Files (CE3): shows the rail's Files section. Nothing outside a rail. */
export function FilesButton() {
  const rail = useRail();
  if (!rail) return null;
  return <IconAction command="files" onClick={() => rail.reveal("files")} />;
}

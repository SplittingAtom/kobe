"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { THREADS_SHARE_BOUNDS } from "@kobe/protocol";
import {
  applyRailCollapsed,
  applyThreadsShare,
  useStoredPreference,
  type LayoutPreferences,
} from "../../lib/shell/preferences";
import { railDocked } from "../../lib/shell/layout";
import { IconAction } from "./icon-action";
import { useShellBand } from "./shell-band";

/**
 * The workspace rail's state (CE5, KOBE-198): collapsed (48 px) or expanded (280 px), and the
 * share of the height the Threads section takes over Files.
 *
 * Both are per user, server-side (CE8, KOBE-202, `lib/shell/preferences.ts`): the provider applies
 * the stored values once they load (unless the member already changed that value on this page)
 * and saves the member's own changes only: the rail's toggle (Collapse, and the collapsed rail's
 * icons, the only way to expand it) and a divider release. Programmatic expansions (the bar's
 * Files, a drop) are not saved.
 *
 * Breakpoints (CE7, KOBE-201): the member's choice is the rail's state on wide windows only.
 * Below 1100 px the rail is collapsed whatever was chosen, and expanding it opens it as a drawer
 * over the shell (under 768 px the rail has no column, so the bar opens the drawer). The drawer is
 * never saved and never touches the choice, so the chosen state comes back when the window grows.
 */
export type RailSection = "threads" | "files";

/** Threads' share of the rail's height: 60% by default, never squeezing either section out. */
export const THREADS_SHARE = {
  initial: 0.6,
  min: THREADS_SHARE_BOUNDS.min,
  max: THREADS_SHARE_BOUNDS.max,
  step: 0.05,
} as const;

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
  /** Showing the collapsed icons (48 px): the member's choice when docked, else no drawer. */
  readonly collapsed: boolean;
  /** Expanded below 1100 px: the rail is a modal drawer over the shell. */
  readonly drawer: boolean;
  readonly threadsShare: number;
  /** The section the member asked to see; the rail focuses it once rendered. */
  readonly revealed: { readonly section: RailSection; readonly seq: number } | null;
  /** Collapses or expands the rail on this page only (automatic; not saved). */
  setCollapsed(collapsed: boolean): void;
  /** Closes the drawer, if open (a thread opened from it). */
  closeDrawer(): void;
  /** The member's own toggle: saved on wide screens. */
  toggle(collapsed: boolean): void;
  /** True once the member's stored layout has been applied (or failed to load). */
  readonly settled: boolean;
  setThreadsShare(share: number): void;
  /** Times the member asked for Files: 0 = not yet (nothing listed or woken); each ask re-wakes. */
  readonly filesRequests: number;
  /**
   * Expands the rail and moves focus to a section (the collapsed icons, the bar's Files).
   * `toggle`: the member expanded the collapsed rail with its own icons (saved like `toggle`).
   */
  reveal(section: RailSection, options?: { readonly toggle?: boolean }): void;
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
  const ready = preferences !== null;
  const docked = railDocked(useShellBand());
  const chosen = useStoredPreference<boolean>({
    initial: false,
    ready,
    resolve: () => applyRailCollapsed(preferences?.railCollapsed),
    save: onSave && ((railCollapsed) => onSave({ railCollapsed })),
  });
  const share = useStoredPreference<number>({
    initial: THREADS_SHARE.initial,
    ready,
    resolve: () => applyThreadsShare(preferences?.threadsShare),
    save: onSave && ((threadsShare) => onSave({ threadsShare })),
  });
  // Set in the same pass as the stored values above, so it renders together with them.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (ready) setSettled(true);
  }, [ready]);
  // The drawer belongs to the band it opened in: a resize across the 1100 px edge closes it.
  const [drawer, setDrawer] = useState({ open: false, docked });
  if (drawer.docked !== docked) setDrawer({ open: false, docked });
  const drawerOpen = !docked && drawer.open;
  const openDrawer = useCallback((open: boolean) => setDrawer({ open, docked }), [docked]);
  const closeDrawer = useCallback(() => openDrawer(false), [openDrawer]);
  const { set: setChosen, commit: commitChosen, current: chosenNow } = chosen;
  const setCollapsed = useCallback(
    (next: boolean) => (docked ? setChosen(next) : openDrawer(!next)),
    [docked, setChosen, openDrawer],
  );
  const collapsedNow = useCallback(
    () => (docked ? chosenNow() : !drawerOpen),
    [docked, chosenNow, drawerOpen],
  );
  const [filesRequests, setFilesRequests] = useState(0);
  const requestFiles = useCallback(() => setFilesRequests((n) => n + 1), []);
  const [revealed, setRevealed] = useState<RailApi["revealed"]>(null);
  // Only the docked rail's toggle is the member's layout; the drawer is not saved.
  const toggle = useCallback(
    (next: boolean) => (docked ? commitChosen(next) : openDrawer(!next)),
    [docked, commitChosen, openDrawer],
  );
  const commitShare = share.commit;
  const setThreadsShare = useCallback(
    (next: number) => commitShare(clampShare(next)),
    [commitShare],
  );
  const reveal = useCallback(
    (section: RailSection, options?: { readonly toggle?: boolean }) => {
      if (options?.toggle && collapsedNow()) toggle(false);
      else setCollapsed(false);
      setRevealed((prev) => ({ section, seq: (prev?.seq ?? 0) + 1 }));
      if (section === "files") setFilesRequests((n) => n + 1);
    },
    [collapsedNow, toggle, setCollapsed],
  );
  const api = useMemo(
    () => ({
      collapsed: docked ? chosen.value : !drawerOpen,
      drawer: drawerOpen,
      threadsShare: share.value,
      revealed,
      filesRequests,
      settled,
      setCollapsed,
      closeDrawer,
      toggle,
      setThreadsShare,
      reveal,
      requestFiles,
    }),
    [
      docked,
      chosen.value,
      drawerOpen,
      share.value,
      revealed,
      filesRequests,
      settled,
      setCollapsed,
      closeDrawer,
      toggle,
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

/** Under 768 px the rail has no column: the bar opens it as a drawer (CE8, KOBE-201). */
export function RailDrawerButton() {
  const rail = useRail();
  const single = useShellBand() === "single";
  if (!rail || !single) return null;
  return (
    <IconAction
      command="open-rail"
      aria-haspopup="dialog"
      aria-expanded={rail.drawer}
      onClick={() => rail.reveal("threads", { toggle: true })}
    />
  );
}

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
import { RAIL_PANELS, THREADS_SHARE_BOUNDS, type RailPanels } from "@kobe/protocol";
import {
  applyThreadsShare,
  useStoredPreference,
  type LayoutPreferences,
} from "../../lib/shell/preferences";
import { railDocked } from "../../lib/shell/layout";
import { DEFAULT_RAIL_PANELS, shows, withPanel } from "../../lib/shell/rail-panels";
import { applyRailWidth, railWidthWithin } from "../../lib/shell/rail-width";
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
 *
 * The expanded rail's width (KOBE-305) is dragged on wide windows only and saved with the other
 * preferences (per user, server-side); collapsing keeps it, so expanding again restores it.
 *
 * Its panels (KOBE-419): Threads, Files or both, from the toggles on the rail's top line, saved per
 * user. Asking for a hidden panel (Show threads, Show files, Mod+Shift+F, a drop) turns it on for
 * this page only, like those paths' expansions.
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
   * Expands the rail and moves focus to a section (the collapsed icons, Mod+Shift+F).
   * `toggle`: the member expanded the collapsed rail with its own icons (saved like `toggle`).
   */
  reveal(section: RailSection, options?: { readonly toggle?: boolean }): void;
  /** Lists the workspace and wakes the sandbox (first use, Show files, refresh). */
  requestFiles(): void;
  /** The expanded rail's dragged width in px (KOBE-305); null is the default, 280 px. */
  readonly width: number | null;
  /** The member resized the rail: kept within its bounds and saved (per user, server-side). */
  setWidth(width: number): void;
  /** Back to the default width (double-click on the handle), saved as `null`. */
  resetWidth(): void;
  /** Which panels show (KOBE-419): Threads, Files or both. */
  readonly panels: RailPanels;
  /** The member's toggle on the rail's top line: saved; the last panel on stays on. */
  setPanel(section: RailSection, on: boolean): void;
  /** Turns a panel on for this page (not saved): a drop's notice must be seen. */
  showPanel(section: RailSection): void;
}

/**
 * The rail's width: the member's stored width (server-side, CE8) applied once loaded unless they
 * already resized on this page; a resize or a reset is saved (the handle is on wide windows only).
 */
function useRailWidth(
  preferences: LayoutPreferences | null,
  onSave: ((change: LayoutPreferences) => void) | undefined,
) {
  const stored = useStoredPreference<number | null>({
    initial: null,
    ready: preferences !== null,
    resolve: () => applyRailWidth(preferences?.railWidth),
    save: onSave && ((railWidth) => onSave({ railWidth })),
  });
  const { commit } = stored;
  const setWidth = useCallback(
    (next: number) => {
      const within = railWidthWithin(next);
      if (within !== null) commit(within);
    },
    [commit],
  );
  const resetWidth = useCallback(() => commit(null), [commit]);
  return { width: stored.value, setWidth, resetWidth };
}

/** A stored panels value this build knows, else null (the default applies). */
function knownPanels(stored: RailPanels | undefined): RailPanels | null {
  return stored !== undefined && RAIL_PANELS.includes(stored) ? stored : null;
}

/**
 * The rail's panels (KOBE-419): the member's stored choice applied once loaded unless they already
 * changed it on this page; their toggles are saved, a reveal is not.
 */
function useRailPanels(
  preferences: LayoutPreferences | null,
  onSave: ((change: LayoutPreferences) => void) | undefined,
) {
  const stored = useStoredPreference<RailPanels>({
    initial: DEFAULT_RAIL_PANELS,
    ready: preferences !== null,
    resolve: () => knownPanels(preferences?.railPanels),
    save: onSave && ((railPanels) => onSave({ railPanels })),
  });
  const { commit, set, current } = stored;
  const setPanel = useCallback(
    (section: RailSection, on: boolean) => commit(withPanel(current(), section, on)),
    [commit, current],
  );
  const showPanel = useCallback(
    (section: RailSection) => {
      if (!shows(current(), section)) set(withPanel(current(), section, true));
    },
    [set, current],
  );
  return { panels: stored.value, setPanel, showPanel };
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
    // The stored state is the wide-window choice; narrower bands collapse on screen only.
    resolve: () => preferences?.railCollapsed ?? null,
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
  const { width, setWidth, resetWidth } = useRailWidth(preferences, onSave);
  const { panels, setPanel, showPanel } = useRailPanels(preferences, onSave);
  const [filesRequests, setFilesRequests] = useState(0);
  const requestFiles = useCallback(() => setFilesRequests((n) => n + 1), []);
  const [revealed, setRevealed] = useState<RailApi["revealed"]>(null);
  // Only the docked rail's toggle is the member's layout; the drawer is not saved.
  const toggle = useCallback(
    (next: boolean) => (docked ? commitChosen(next) : openDrawer(!next)),
    [docked, commitChosen, openDrawer],
  );
  // The drawer's divider sits in a different height: it moves the drawer only, unsaved, and the
  // docked rail keeps the member's share.
  const [drawerShare, setDrawerShare] = useState<number | null>(null);
  const commitShare = share.commit;
  const setThreadsShare = useCallback(
    (next: number) => (docked ? commitShare : setDrawerShare)(clampShare(next)),
    [docked, commitShare],
  );
  const threadsShare = docked ? share.value : (drawerShare ?? share.value);
  const reveal = useCallback(
    (section: RailSection, options?: { readonly toggle?: boolean }) => {
      if (options?.toggle && collapsedNow()) toggle(false);
      else setCollapsed(false);
      showPanel(section);
      setRevealed((prev) => ({ section, seq: (prev?.seq ?? 0) + 1 }));
      if (section === "files") setFilesRequests((n) => n + 1);
    },
    [collapsedNow, toggle, setCollapsed, showPanel],
  );
  const api = useMemo(
    () => ({
      collapsed: docked ? chosen.value : !drawerOpen,
      drawer: drawerOpen,
      threadsShare,
      revealed,
      filesRequests,
      settled,
      setCollapsed,
      closeDrawer,
      toggle,
      setThreadsShare,
      reveal,
      requestFiles,
      width,
      setWidth,
      resetWidth,
      panels,
      setPanel,
      showPanel,
    }),
    [
      docked,
      chosen.value,
      drawerOpen,
      threadsShare,
      revealed,
      filesRequests,
      settled,
      setCollapsed,
      closeDrawer,
      toggle,
      setThreadsShare,
      reveal,
      requestFiles,
      width,
      setWidth,
      resetWidth,
      panels,
      setPanel,
      showPanel,
    ],
  );
  return <RailContext.Provider value={api}>{children}</RailContext.Provider>;
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

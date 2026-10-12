"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { IconAction } from "./icon-action";

/**
 * The workspace rail's state (CE5, KOBE-198): collapsed (48 px) or expanded (280 px), and the
 * share of the height the Threads section takes over Files.
 *
 * Slot (A6, KOBE-202): CE8 keeps the collapsed state and the divider position per user,
 * server-side. Until A6 loads and saves them here, they live in memory for the page's lifetime.
 */
export type RailSection = "threads" | "files";

/** Threads' share of the rail's height: 60% by default, never squeezing either section out. */
export const THREADS_SHARE = { initial: 0.6, min: 0.2, max: 0.8, step: 0.05 } as const;

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
  return Math.round(clamped * 1000) / 1000;
}

export interface RailApi {
  readonly collapsed: boolean;
  readonly threadsShare: number;
  /** The section the member asked to see; the rail focuses it once rendered. */
  readonly revealed: { readonly section: RailSection; readonly seq: number } | null;
  setCollapsed(collapsed: boolean): void;
  setThreadsShare(share: number): void;
  /** Expands the rail and moves focus to a section (the collapsed icons, the bar's Files). */
  reveal(section: RailSection): void;
}

const RailContext = createContext<RailApi | null>(null);

export function useRail(): RailApi | null {
  return useContext(RailContext);
}

export function RailProvider({ children }: { readonly children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(isNarrowScreen);
  const [threadsShare, setShare] = useState<number>(THREADS_SHARE.initial);
  const [revealed, setRevealed] = useState<RailApi["revealed"]>(null);
  const setThreadsShare = useCallback((share: number) => setShare(clampShare(share)), []);
  const reveal = useCallback((section: RailSection) => {
    setCollapsed(false);
    setRevealed((prev) => ({ section, seq: (prev?.seq ?? 0) + 1 }));
  }, []);
  const api = useMemo(
    () => ({ collapsed, threadsShare, revealed, setCollapsed, setThreadsShare, reveal }),
    [collapsed, threadsShare, revealed, setThreadsShare, reveal],
  );
  return <RailContext.Provider value={api}>{children}</RailContext.Provider>;
}

/** Bar row two's Files (CE3): shows the rail's Files section. Nothing outside a rail. */
export function FilesButton() {
  const rail = useRail();
  if (!rail) return null;
  return <IconAction command="files" onClick={() => rail.reveal("files")} />;
}

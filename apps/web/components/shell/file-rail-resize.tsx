"use client";

import { THREADS_FILE_RAIL_WIDTH_BOUNDS } from "@kobe/protocol";
import { useCallback, type CSSProperties } from "react";
import { useShellPreferences, useStoredPreference } from "../../lib/shell/preferences";
import { useSplitter, type SplitterRange } from "./use-splitter";

/**
 * The Threads panel's workspace rail width (KOBE-614): folders | threads | workspace, with the
 * shell's window splitter (`use-splitter.ts`, as the workspace rail, the artifact column and the
 * Workbench editor) on the line between the threads and the workspace rail. Drag it, or
 * Left/Right (the rail is after the handle, so Left widens it), Page Up/Down, Home/End; Enter or a
 * double-click goes back to the default. The width is saved per member with the other layout
 * preferences (server-side, `threads_file_rail_width`).
 *
 * By default the thread column is as wide as its titles (up to 28rem, at least 12rem) and the
 * rail takes the rest, so no empty band sits right of the names. A dragged width gives the rail
 * that width (as the window allows) and the thread column the rest.
 */
export const FILE_RAIL_ID = "kobe-threads-file-rail";
const THREADS_VAR = "--kobe-threads-col";
const RAIL_VAR = "--kobe-file-rail-col";
const RAIL_MIN_PX = THREADS_FILE_RAIL_WIDTH_BOUNDS.min;
/** The folder column (200 px), the two 1 px dividers and the four 12 px gaps. */
const FIXED_PX = 200 + 2 + 4 * 12;
/** The thread column's floor (12rem). */
const THREADS_MIN_PX = 192;
const STEP_PX = 24;

/** The body's grid: its thread and rail columns come from two custom properties. */
export const THREE_RAIL_COLUMNS =
  "grid-cols-[200px_1px_var(--kobe-threads-col)_1px_var(--kobe-file-rail-col)]";

/** The two columns for a width (null: the default). */
export function railColumns(width: number | null): { threads: string; rail: string } {
  return width === null
    ? { threads: "fit-content(28rem)", rail: `minmax(${RAIL_MIN_PX}px,1fr)` }
    : { threads: "minmax(12rem,1fr)", rail: `minmax(${RAIL_MIN_PX}px,${width}px)` };
}

/** The body's style for a width: the two columns. */
export function railStyle(width: number | null): CSSProperties {
  const c = railColumns(width);
  return { [THREADS_VAR]: c.threads, [RAIL_VAR]: c.rail } as CSSProperties;
}

function setColumns(body: HTMLElement | null, width: number | null): void {
  const c = railColumns(width);
  body?.style.setProperty(THREADS_VAR, c.threads);
  body?.style.setProperty(RAIL_VAR, c.rail);
}

function regions(handle: HTMLElement | null) {
  const body = handle?.closest<HTMLElement>("[data-kobe-threads-body]") ?? null;
  const rail = body?.querySelector<HTMLElement>(`#${FILE_RAIL_ID}`) ?? null;
  return { body, rail };
}

/** The rail's width and its bounds: the folders and the thread column keep their floors. */
function measure(handle: HTMLElement | null): SplitterRange | null {
  const { body, rail } = regions(handle);
  const space = body?.getBoundingClientRect().width ?? 0;
  const width = rail?.getBoundingClientRect().width ?? 0;
  const max = Math.floor(space - FIXED_PX - THREADS_MIN_PX);
  if (width <= 0 || max < RAIL_MIN_PX) return null;
  return { value: width, min: RAIL_MIN_PX, max };
}

function observe(handle: HTMLElement | null): readonly Element[] {
  const { body, rail } = regions(handle);
  return body && rail ? [body, rail] : [];
}

/** The rail's right edge stays put: the pointer at the handle sets its left edge. */
function pointerValue(clientX: number, handle: HTMLElement): number | null {
  const { rail } = regions(handle);
  return rail ? rail.getBoundingClientRect().right - clientX : null;
}

function preview(width: number, handle: HTMLElement): void {
  setColumns(regions(handle).body, width);
}

/** The member's rail width (null: the default), applied once the shell's preferences load. */
export function useFileRailWidth() {
  const shell = useShellPreferences();
  const preferences = shell?.preferences ?? null;
  const save = shell?.save;
  const stored = useStoredPreference<number | null>({
    initial: null,
    ready: preferences !== null,
    resolve: () => preferences?.threadsFileRailWidth ?? null,
    save: save && ((threadsFileRailWidth) => save({ threadsFileRailWidth })),
  });
  const { commit } = stored;
  const setWidth = useCallback(
    (next: number) =>
      commit(Math.min(THREADS_FILE_RAIL_WIDTH_BOUNDS.max, Math.max(RAIL_MIN_PX, Math.round(next)))),
    [commit],
  );
  const resetWidth = useCallback(() => commit(null), [commit]);
  return { width: stored.value, setWidth, resetWidth };
}

/** The line between the threads and the workspace rail, a drag handle (a few px wide to grab). */
export function FileRailResizeHandle({
  width,
  onChange,
  onReset,
}: {
  readonly width: number | null;
  onChange(width: number): void;
  onReset(): void;
}) {
  const splitter = useSplitter({
    measure,
    observe,
    pointerValue,
    preview,
    commit: (next) => {
      if (next !== width) onChange(next);
    },
    reset: onReset,
    reversed: true,
    // Unmounted mid-drag: the body shows the committed width again.
    revert: () => {
      setColumns(document.querySelector<HTMLElement>("[data-kobe-threads-body]"), width);
    },
    step: STEP_PX,
    fallback: { value: width ?? RAIL_MIN_PX, min: RAIL_MIN_PX, max: RAIL_MIN_PX },
  });
  return (
    <div
      {...splitter}
      aria-label="Resize the workspace files"
      aria-controls={FILE_RAIL_ID}
      data-kobe-file-rail-handle=""
      className="group relative z-20 flex w-px cursor-col-resize touch-none justify-center self-stretch outline-none"
    >
      {/* A wider strip to grab than the 1 px line it shows. */}
      <span aria-hidden className="absolute inset-y-0 -start-1.5 -end-1.5" />
      <span
        aria-hidden
        className="bg-border group-hover:bg-ring group-focus-visible:bg-ring h-full w-px shrink-0 group-hover:w-1 group-focus-visible:w-1"
      />
    </div>
  );
}

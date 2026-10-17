"use client";

import { maxRailWidth, RAIL_PX } from "../../lib/shell/layout";
import { shellGrid } from "../../lib/shell/preferences";
import { RAIL_STEP_PX, RAIL_WIDTH_VAR } from "../../lib/shell/rail-width";
import styles from "./shell.module.css";
import { useSplitter, type SplitterRange } from "./use-splitter";

export const RAIL_ID = "kobe-workspace-rail";

function regions(handle: HTMLElement | null) {
  const rail = handle?.closest<HTMLElement>('[data-shell-region="rail"]') ?? null;
  const grid = rail?.parentElement ?? null;
  const artifact =
    grid?.querySelector<HTMLElement>(':scope > [data-shell-region="artifact"]') ?? null;
  return { rail, grid, artifact };
}

/**
 * The rail's width and its bounds: the conversation keeps its 400 px floor beside it, and the
 * artifact column its 360 px one while it is a column (it takes no width while empty or hidden).
 */
function measure(handle: HTMLElement | null): SplitterRange | null {
  const { rail, grid, artifact } = regions(handle);
  const width = rail?.getBoundingClientRect().width ?? 0;
  const space = grid?.getBoundingClientRect().width ?? 0;
  if (width <= 0 || space <= 0) return null;
  const column = (artifact?.getBoundingClientRect().width ?? 0) > 0;
  return { value: width, min: RAIL_PX.min, max: maxRailWidth(space, column) };
}

/** The artifact column too: opening or closing it moves the maximum without resizing the rail. */
function observe(handle: HTMLElement | null): readonly Element[] {
  const { rail, grid, artifact } = regions(handle);
  return rail && grid ? [rail, grid, ...(artifact ? [artifact] : [])] : [];
}

function pointerValue(clientX: number, handle: HTMLElement): number | null {
  const { rail } = regions(handle);
  return rail ? clientX - rail.getBoundingClientRect().left : null;
}

function preview(width: number, handle: HTMLElement): void {
  regions(handle).grid?.style.setProperty(RAIL_WIDTH_VAR, `${width}px`);
}

/**
 * The drag handle on the expanded rail's right edge (KOBE-305): the artifact column's splitter
 * (`use-splitter.ts`) with the rail's bounds, from 200 px (names still readable) to 560 px or
 * less, so the conversation (and an open artifact column) keep their floors. Arrow keys step
 * 24 px, Page Up/Down four steps (stopping on 280 px on the way past), Home/End jump to the
 * bounds; Enter or a double-click goes back to 280 px.
 * Rendered on wide windows only, while the rail is expanded: collapsed (Mod+B), narrower bands
 * and the drawer have no handle, and the chosen width comes back when the rail expands.
 */
export function RailResizeHandle({
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
    snap: RAIL_PX.expanded,
    // Unmounted mid-drag: the grid shows the committed width again (React's style owns it).
    revert: () => {
      const grid = shellGrid();
      if (width === null) grid?.style.removeProperty(RAIL_WIDTH_VAR);
      else grid?.style.setProperty(RAIL_WIDTH_VAR, `${width}px`);
    },
    step: RAIL_STEP_PX,
    fallback: { value: width ?? RAIL_PX.expanded, min: RAIL_PX.min, max: RAIL_PX.max },
  });
  return (
    <div
      {...splitter}
      aria-label="Resize the workspace rail"
      aria-controls={RAIL_ID}
      className={styles.railHandle}
    />
  );
}

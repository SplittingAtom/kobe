"use client";

import {
  ARTIFACT_FLOOR_PX,
  ARTIFACT_WIDTH_VAR,
  maxArtifactWidth,
} from "../../lib/chat/artifact-tabs";
import { spaceRightOfRail } from "../../lib/shell/preferences";
import styles from "./shell.module.css";
import { useSplitter, type SplitterRange } from "./use-splitter";

const STEP_PX = 24;
const FALLBACK: SplitterRange = {
  value: ARTIFACT_FLOOR_PX,
  min: ARTIFACT_FLOOR_PX,
  max: ARTIFACT_FLOOR_PX,
};

function regions(handle: HTMLElement | null) {
  const column = handle?.closest<HTMLElement>('[data-shell-region="artifact"]') ?? null;
  const grid = column?.parentElement ?? null;
  const conversation =
    grid?.querySelector<HTMLElement>(':scope > [data-shell-region="conversation"]') ?? null;
  return { column, grid, conversation };
}

/** The column's width and its bounds: the space right of the rail holds both floors. */
function measure(handle: HTMLElement | null): SplitterRange | null {
  const { column, grid } = regions(handle);
  const available = spaceRightOfRail(grid);
  if (!column || available === null) return null;
  return {
    value: column.getBoundingClientRect().width,
    min: ARTIFACT_FLOOR_PX,
    max: maxArtifactWidth(available),
  };
}

function observe(handle: HTMLElement | null): readonly Element[] {
  const { column, conversation } = regions(handle);
  return column && conversation ? [column, conversation] : [];
}

function pointerValue(clientX: number, handle: HTMLElement): number | null {
  const { column } = regions(handle);
  return column ? clientX - column.getBoundingClientRect().left : null;
}

function preview(width: number, handle: HTMLElement): void {
  regions(handle).grid?.style.setProperty(ARTIFACT_WIDTH_VAR, `${width}px`);
}

/**
 * The drag handle between the artifact column and the conversation (CE6, CE7): a focusable
 * window splitter (WAI-ARIA `separator`, `use-splitter.ts`) whose value is the column's width in
 * px. Drag it, or use the arrow keys, Page Up/Down, Home (the 360 px floor) and End (the
 * conversation's 400 px floor). A drag moves the grid's column directly and commits once, on
 * release. `width` null is the default, half the space right of the rail; the CSS keeps both
 * floors when the window narrows.
 */
export function ArtifactResizeHandle({
  width,
  onChange,
}: {
  readonly width: number | null;
  onChange(width: number): void;
}) {
  const splitter = useSplitter({
    measure,
    observe,
    pointerValue,
    preview,
    commit: (next) => {
      if (next !== width) onChange(next);
    },
    step: STEP_PX,
    fallback: FALLBACK,
  });
  return (
    <div
      {...splitter}
      aria-label="Resize the artifact column and the conversation"
      aria-controls="kobe-artifact-column"
      className={styles.resizeHandle}
    />
  );
}

"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  ARTIFACT_FLOOR_PX,
  ARTIFACT_WIDTH_VAR,
  clampArtifactWidth,
  maxArtifactWidth,
} from "../../lib/chat/artifact-tabs";
import styles from "./shell.module.css";

const STEP_PX = 24;

const KEY_STEPS: Readonly<Record<string, (width: number, max: number) => number>> = {
  ArrowLeft: (w) => w - STEP_PX,
  ArrowRight: (w) => w + STEP_PX,
  PageDown: (w) => w - 4 * STEP_PX,
  PageUp: (w) => w + 4 * STEP_PX,
  Home: () => ARTIFACT_FLOOR_PX,
  End: (_w, max) => max,
};

interface Measure {
  readonly column: number;
  /** The artifact column and the conversation together: the space right of the rail. */
  readonly available: number;
}

function regions(handle: HTMLElement | null) {
  const column = handle?.closest<HTMLElement>('[data-shell-region="artifact"]') ?? null;
  const grid = column?.parentElement ?? null;
  const conversation =
    grid?.querySelector<HTMLElement>(':scope > [data-shell-region="conversation"]') ?? null;
  return { column, grid, conversation };
}

function measure(handle: HTMLElement | null): Measure | null {
  const { column, conversation } = regions(handle);
  if (!column || !conversation) return null;
  const width = column.getBoundingClientRect().width;
  const available = width + conversation.getBoundingClientRect().width;
  return available > 0 ? { column: width, available } : null;
}

/**
 * The drag handle between the artifact column and the conversation (CE6, CE7): a focusable
 * window splitter (WAI-ARIA `separator`) whose value is the column's width in px. Drag it, or use
 * the arrow keys, Page Up/Down, Home (the 360 px floor) and End (the conversation's 400 px floor).
 * A drag moves the grid's column directly and commits once, on release. `width` null is the
 * default, half the space right of the rail; the CSS keeps both floors when the window narrows.
 */
export function ArtifactResizeHandle({
  width,
  onChange,
}: {
  readonly width: number | null;
  onChange(width: number): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Measure | null>(null);
  /** The width shown while dragging; committed on release (null: not dragging). */
  const dragged = useRef<number | null>(null);

  const remeasure = useCallback(() => setSize(measure(ref.current)), []);
  useEffect(() => {
    remeasure();
    window.addEventListener("resize", remeasure);
    return () => window.removeEventListener("resize", remeasure);
  }, [remeasure, width]);

  const commit = (next: number) => {
    if (next !== width) onChange(next);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragged.current = width ?? measure(e.currentTarget)?.column ?? null;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragged.current === null) return;
    const { column, grid } = regions(e.currentTarget);
    const now = measure(e.currentTarget);
    if (!column || !grid || !now) return;
    const next = clampArtifactWidth(e.clientX - column.getBoundingClientRect().left, now.available);
    dragged.current = next;
    grid.style.setProperty(ARTIFACT_WIDTH_VAR, `${next}px`);
    e.currentTarget.setAttribute("aria-valuenow", String(next));
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    const next = dragged.current;
    dragged.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (next !== null) commit(next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEPS[e.key];
    const now = measure(e.currentTarget);
    if (!step || !now) return;
    e.preventDefault();
    commit(clampArtifactWidth(step(now.column, maxArtifactWidth(now.available)), now.available));
  };

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the artifact column and the conversation"
      aria-controls="kobe-artifact-column"
      aria-valuenow={size ? Math.round(size.column) : ARTIFACT_FLOOR_PX}
      aria-valuemin={ARTIFACT_FLOOR_PX}
      aria-valuemax={size ? maxArtifactWidth(size.available) : ARTIFACT_FLOOR_PX}
      tabIndex={0}
      className={styles.resizeHandle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={onKeyDown}
    />
  );
}

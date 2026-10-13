"use client";

import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { clampShare, sectionRows, THREADS_SHARE } from "./rail-state";
import styles from "./rail.module.css";

const KEY_STEPS: Readonly<Record<string, (share: number) => number>> = {
  ArrowUp: (s) => s - THREADS_SHARE.step,
  ArrowDown: (s) => s + THREADS_SHARE.step,
  PageUp: (s) => s - 2 * THREADS_SHARE.step,
  PageDown: (s) => s + 2 * THREADS_SHARE.step,
  Home: () => THREADS_SHARE.min,
  End: () => THREADS_SHARE.max,
};

/**
 * The draggable divider between Threads and Files (CE5): a focusable window splitter (WAI-ARIA
 * `separator`) whose value is Threads' share in percent. Drag it, or use the arrow keys, Page
 * Up/Down, Home and End. A drag moves the rows directly and commits once, on release, so the
 * rail does not re-render on every pointer move. `onChange` clamps.
 */
export function RailDivider({
  share,
  onChange,
  container,
  controls,
}: {
  readonly share: number;
  onChange(share: number): void;
  /** The element the two sections share: the pointer's position is read against it. */
  readonly container: RefObject<HTMLElement | null>;
  readonly controls: string;
}) {
  /** The share shown while dragging; committed on release (null: not dragging). */
  const dragged = useRef<number | null>(null);

  /** The pointer's share of the two sections' rows (the grid minus the divider's own row). */
  const shareAt = (clientY: number, divider: HTMLElement): number | null => {
    const box = container.current?.getBoundingClientRect();
    const own = divider.getBoundingClientRect().height;
    const rows = (box?.height ?? 0) - own;
    return box && rows > 0 ? clampShare((clientY - box.top - own / 2) / rows) : null;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragged.current = share;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragged.current === null) return;
    const next = shareAt(e.clientY, e.currentTarget);
    if (next === null || container.current === null) return;
    dragged.current = next;
    container.current.style.gridTemplateRows = sectionRows(next);
    e.currentTarget.setAttribute("aria-valuenow", String(Math.round(next * 100)));
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    const next = dragged.current;
    dragged.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (next !== null && next !== share) onChange(next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEPS[e.key];
    if (!step) return;
    e.preventDefault();
    onChange(step(share));
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize Threads and Files"
      aria-controls={controls}
      aria-valuenow={Math.round(share * 100)}
      aria-valuemin={Math.round(THREADS_SHARE.min * 100)}
      aria-valuemax={Math.round(THREADS_SHARE.max * 100)}
      tabIndex={0}
      className={styles.divider}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={onKeyDown}
    />
  );
}

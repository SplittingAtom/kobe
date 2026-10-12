"use client";

import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { THREADS_SHARE } from "./rail-state";
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
 * Up/Down, Home and End. `onChange` clamps.
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
  const dragging = useRef(false);

  const shareAt = (clientY: number): number | null => {
    const box = container.current?.getBoundingClientRect();
    return box && box.height > 0 ? (clientY - box.top) / box.height : null;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const next = shareAt(e.clientY);
    if (next !== null) onChange(next);
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
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

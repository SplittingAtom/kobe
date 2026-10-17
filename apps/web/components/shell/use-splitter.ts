"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";

/**
 * The shell's vertical window splitters (WAI-ARIA `separator`, KOBE-200, KOBE-305): the artifact
 * column's edge and the rail's edge share this one implementation. The value is a column's width
 * in px; the caller says how to read it and its bounds from the layout, how to show a dragged
 * value without a render (a custom property on the grid) and what to do with a chosen value.
 *
 * - Drag: a press that moves less than {@link DRAG_THRESHOLD_PX} is a click (nothing changes);
 *   a drag shows each value directly and commits once, on release.
 * - Keys: arrows by one step, Page Up/Down by four, Home the minimum, End the maximum; a step
 *   that crosses `snap` (the default width) stops on it, so the keys reach it. Modified keys
 *   (Alt, Ctrl, Cmd) pass through to the browser.
 * - Enter or a double-click: `reset` (back to the default), when the caller has one.
 * - A handle unmounted mid-drag (Mod+B, the window crossing a band) calls `revert`, so the
 *   dragged value shown without a render doesn't outlive it.
 * - The aria values follow the real sizes (a dragged width, the rail collapsing, the window).
 */
export interface SplitterRange {
  readonly value: number;
  readonly min: number;
  readonly max: number;
}

/** A press that moves less than this is a click: it leaves the width alone (default stays). */
export const DRAG_THRESHOLD_PX = 3;

type KeyStep = (value: number, range: SplitterRange, step: number) => number;

const KEY_STEPS: Readonly<Record<string, KeyStep>> = {
  ArrowLeft: (v, _r, s) => v - s,
  ArrowRight: (v, _r, s) => v + s,
  PageDown: (v, _r, s) => v - 4 * s,
  PageUp: (v, _r, s) => v + 4 * s,
  Home: (_v, r) => r.min,
  End: (_v, r) => r.max,
};

/** Arrow and Page keys: a step from `from` to `to` that crosses `snap` stops on it. */
export function snapStep(from: number, to: number, snap: number | undefined): number {
  if (snap === undefined) return to;
  return (from < snap && to > snap) || (from > snap && to < snap) ? snap : to;
}

/** `value` within the range's bounds, in whole px. */
export function clampToRange(value: number, range: Pick<SplitterRange, "min" | "max">): number {
  return Math.round(Math.min(range.max, Math.max(range.min, value)));
}

export interface SplitterOptions {
  /** The value and its bounds as laid out now; null while the shell isn't laid out. */
  measure(handle: HTMLElement | null): SplitterRange | null;
  /** Elements whose size moves the range; none: the window's resize is watched instead. */
  observe(handle: HTMLElement | null): readonly Element[];
  /** The (unclamped) value with the edge at the pointer; null when it can't be read. */
  pointerValue(clientX: number, handle: HTMLElement): number | null;
  /** Shows a dragged value at once, without a render. */
  preview(value: number, handle: HTMLElement): void;
  /** A value the member chose (a key, a release), within the bounds. */
  commit(value: number): void;
  /** Enter or double-click: back to the default. Absent: both do nothing. */
  readonly reset?: (() => void) | undefined;
  /** The default value, where arrow and Page steps stop on their way past. */
  readonly snap?: number | undefined;
  /** The handle unmounted mid-drag: undo the preview (show the committed value again). */
  readonly revert?: (() => void) | undefined;
  /** One arrow key's step in px. */
  readonly step: number;
  /** The aria values until the first measure. */
  readonly fallback: SplitterRange;
}

export interface SplitterProps {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly role: "separator";
  readonly "aria-orientation": "vertical";
  readonly "aria-valuenow": number;
  readonly "aria-valuemin": number;
  readonly "aria-valuemax": number;
  readonly tabIndex: 0;
  readonly "aria-keyshortcuts"?: string;
  onPointerDown(e: PointerEvent<HTMLDivElement>): void;
  onPointerMove(e: PointerEvent<HTMLDivElement>): void;
  onPointerUp(e: PointerEvent<HTMLDivElement>): void;
  onPointerCancel(e: PointerEvent<HTMLDivElement>): void;
  onKeyDown(e: KeyboardEvent<HTMLDivElement>): void;
  onFocus(): void;
  onDoubleClick?: () => void;
}

/** Follows the range as the observed elements (or the window) resize. */
function useMeasuredRange(
  ref: RefObject<HTMLDivElement | null>,
  latest: RefObject<SplitterOptions>,
): readonly [SplitterRange | null, (next: SplitterRange | null) => void, () => void] {
  const [range, setState] = useState<SplitterRange | null>(null);
  // Unchanged bounds keep the same object: no render for a key the splitter doesn't handle.
  const setRange = useCallback(
    (next: SplitterRange | null) =>
      setState((prev) =>
        prev !== null &&
        next !== null &&
        prev.value === next.value &&
        prev.min === next.min &&
        prev.max === next.max
          ? prev
          : next,
      ),
    [],
  );
  const remeasure = useCallback(
    () => setRange(latest.current.measure(ref.current)),
    [ref, latest, setRange],
  );
  useEffect(() => {
    remeasure();
    const targets = latest.current.observe(ref.current);
    if (typeof ResizeObserver === "undefined" || targets.length === 0) {
      window.addEventListener("resize", remeasure);
      return () => window.removeEventListener("resize", remeasure);
    }
    const observer = new ResizeObserver(remeasure);
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [ref, latest, remeasure]);
  return [range, setRange, remeasure] as const;
}

/** The splitter's props: spread them on the handle's `<div>` (add its label and controls). */
export function useSplitter(options: SplitterOptions): SplitterProps {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const [range, setRange, remeasure] = useMeasuredRange(ref, latest);
  /** The drag under way: where it started, and the value shown once it moved (else null). */
  const drag = useRef<{ readonly startX: number; readonly value: number | null } | null>(null);
  useEffect(
    () => () => {
      const dragged = drag.current?.value ?? null;
      drag.current = null;
      if (dragged !== null) latest.current.revert?.();
    },
    [],
  );
  const { measure, pointerValue, preview, commit, reset, snap, step, fallback } = options;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { startX: e.clientX, value: null };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null) return;
    if (current.value === null && Math.abs(e.clientX - current.startX) < DRAG_THRESHOLD_PX) return;
    const now = measure(e.currentTarget);
    const raw = pointerValue(e.clientX, e.currentTarget);
    if (!now || raw === null) return;
    const next = clampToRange(raw, now);
    drag.current = { ...current, value: next };
    preview(next, e.currentTarget);
    e.currentTarget.setAttribute("aria-valuenow", String(next));
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    const next = drag.current?.value ?? null;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (next !== null) commit(next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return; // the browser's own (Alt+Left is Back)
    if (e.key === "Enter" && reset) {
      e.preventDefault();
      reset();
      return;
    }
    const keyStep = KEY_STEPS[e.key];
    const now = measure(e.currentTarget);
    if (!keyStep || !now) {
      setRange(now);
      return;
    }
    e.preventDefault();
    const stepped = keyStep(now.value, now, step);
    const isEdge = e.key === "Home" || e.key === "End";
    const next = clampToRange(isEdge ? stepped : snapStep(now.value, stepped, snap), now);
    // Announced at once; the observer corrects it if the layout gives the column less.
    setRange({ ...now, value: next });
    commit(next);
  };

  const shown = range ?? fallback;
  return {
    ref,
    role: "separator",
    "aria-orientation": "vertical",
    "aria-valuenow": Math.round(shown.value),
    "aria-valuemin": shown.min,
    "aria-valuemax": shown.max,
    tabIndex: 0,
    ...(reset ? { "aria-keyshortcuts": "Enter" } : {}),
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
    onKeyDown,
    onFocus: remeasure,
    ...(reset ? { onDoubleClick: reset } : {}),
  };
}

"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  curvePath,
  intersect,
  markerText,
  planLines,
  relativeBox,
  type Box,
  type LinePlan,
  type LineTarget,
  type Side,
  type TargetRail,
} from "../../lib/threads/line-model";

/** A row whose lines show: hovered, focused or pinned, with what it links to. */
export interface ActiveSource {
  readonly side: Side;
  readonly key: string;
  readonly targets: readonly LineTarget[];
}

const EMPTY: LinePlan = { lines: [], markers: [], overflow: 0, unplaced: 0 };
const SCROLLS = /(auto|scroll|hidden|clip)/u;

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The part of `el` on screen: its box cut by every clipping ancestor and the window. */
function visibleRect(el: Element): Box {
  let box: Box = el.getBoundingClientRect();
  for (let p = el.parentElement; p !== null; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (SCROLLS.test(`${style.overflowY}${style.overflowX}`)) {
      box = intersect(box, p.getBoundingClientRect());
    }
  }
  const view: Box = { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };
  return intersect(box, view);
}

function rowsOf(column: Element, origin: Box, side: Side): Map<string, Box> {
  const out = new Map<string, Box>();
  if (side === "thread") {
    for (const li of column.querySelectorAll<HTMLElement>("[data-kobe-thread]")) {
      const id = li.dataset["kobeThread"];
      // The row itself, not the files list opened under it.
      const row = li.firstElementChild ?? li;
      if (id && !out.has(id)) out.set(id, relativeBox(row.getBoundingClientRect(), origin));
    }
  } else {
    for (const li of column.querySelectorAll<HTMLElement>('[role="treeitem"][data-path]')) {
      const path = li.dataset["path"];
      if (path && !out.has(path)) out.set(path, relativeBox(li.getBoundingClientRect(), origin));
    }
  }
  return out;
}

function measure(
  container: HTMLElement,
  threads: HTMLElement,
  files: HTMLElement,
  sources: readonly ActiveSource[],
): LinePlan {
  const origin = container.getBoundingClientRect();
  const rail = (el: HTMLElement, side: Side): TargetRail => ({
    rows: rowsOf(el, origin, side),
    viewport: relativeBox(visibleRect(el), origin),
  });
  const rails = { thread: rail(threads, "thread"), file: rail(files, "file") };
  return planLines(
    sources.flatMap((s) => {
      const box = rails[s.side].rows.get(s.key);
      return box ? [{ ...s, box, viewport: rails[s.side].viewport }] : [];
    }),
    rails,
  );
}

/**
 * The SVG over the three rails (KOBE-612, spec §5): lines from the active rows to what they link
 * to, solid for written and dashed for read (TFM1), a count where a closed folder stands for
 * several files, "N more above/below" at a rail's edge, "+N" past the cap. Redrawn on scroll,
 * resize and row changes, once per frame; theme tokens; no fade under reduced motion. Decorative:
 * the same links are lists in the rows (aria-hidden here).
 */
export function FileMapOverlay({
  containerRef,
  threadsRef,
  filesRef,
  sources,
}: {
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly threadsRef: RefObject<HTMLElement | null>;
  readonly filesRef: RefObject<HTMLElement | null>;
  readonly sources: readonly ActiveSource[];
}) {
  const [plan, setPlan] = useState<LinePlan>(EMPTY);
  const latest = useRef(sources);
  latest.current = sources;
  const frame = useRef<number | null>(null);
  const active = sources.length > 0;

  const schedule = useRef(() => {});
  schedule.current = () => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const c = containerRef.current;
      const t = threadsRef.current;
      const f = filesRef.current;
      if (!c || !t || !f || latest.current.length === 0) return setPlan(EMPTY);
      setPlan(measure(c, t, f, latest.current));
    });
  };

  // Every change of the active rows or their links.
  useIsoLayoutEffect(() => {
    schedule.current();
  }, [sources]);

  // Scroll anywhere in the panel, size changes, rows added or folded: redraw while lines show.
  useEffect(() => {
    if (!active) return;
    const c = containerRef.current;
    if (!c) return;
    const redraw = () => schedule.current();
    window.addEventListener("scroll", redraw, true);
    window.addEventListener("resize", redraw);
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(redraw) : null;
    for (const el of [c, threadsRef.current, filesRef.current]) if (el) resize?.observe(el);
    const rows = typeof MutationObserver === "function" ? new MutationObserver(redraw) : null;
    // The rails only: the overlay's own changes must not redraw it again.
    for (const el of [threadsRef.current, filesRef.current]) {
      if (el) rows?.observe(el, { childList: true, subtree: true });
    }
    return () => {
      window.removeEventListener("scroll", redraw, true);
      window.removeEventListener("resize", redraw);
      resize?.disconnect();
      rows?.disconnect();
    };
  }, [active, containerRef, threadsRef, filesRef]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  if (!active || (plan.lines.length === 0 && plan.markers.length === 0)) return null;
  const first = plan.lines[0];
  return (
    <div
      aria-hidden
      data-kobe-file-lines=""
      className="pointer-events-none absolute inset-0 z-10 motion-safe:animate-in motion-safe:fade-in"
    >
      <svg className="absolute inset-0 size-full overflow-visible">
        {plan.lines.map((line) => (
          <g key={line.id} data-kobe-line={line.anchor} data-access={line.access}>
            <path
              d={curvePath(line)}
              fill="none"
              stroke="var(--primary)"
              strokeWidth={line.access === "write" ? 1.75 : 1.25}
              strokeDasharray={line.access === "read" ? "4 3" : undefined}
              strokeLinecap="round"
            />
            <circle cx={line.x1} cy={line.y1} r={2} fill="var(--primary)" />
            <circle cx={line.x2} cy={line.y2} r={2} fill="var(--primary)" />
          </g>
        ))}
      </svg>
      {plan.lines
        .filter((l) => l.count > 1 || l.aggregated)
        .map((l) => (
          <span
            key={`${l.id}:n`}
            data-kobe-line-count={l.anchor}
            className="bg-primary text-primary-foreground absolute rounded-full px-1 text-[0.6rem] leading-4 tabular-nums"
            style={{ top: l.y2 - 8, left: l.x2 - 4, transform: "translateX(-100%)" }}
          >
            {l.count}
          </span>
        ))}
      {plan.markers.map((m) => (
        <span
          key={m.id}
          data-kobe-line-marker={m.position}
          className="bg-background text-muted-foreground absolute rounded-sm border px-1 text-[0.65rem] leading-4"
          style={{
            top: m.position === "above" ? m.y : m.y - 16,
            left: m.x,
            transform: m.side === "thread" ? "translateX(-100%)" : undefined,
          }}
        >
          {markerText(m)}
        </span>
      ))}
      {plan.overflow > 0 && first && (
        <span
          data-kobe-line-overflow=""
          className="bg-background text-muted-foreground absolute rounded-sm border px-1 text-[0.65rem] leading-4"
          style={{ top: first.y1 - 8, left: (first.x1 + first.x2) / 2 }}
        >
          +{plan.overflow}
        </span>
      )}
    </div>
  );
}

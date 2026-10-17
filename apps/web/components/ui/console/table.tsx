"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "../../../lib/utils";
import { FOCUS_RING } from "./focus";

const CELL = "border-b border-console-border px-2.5 py-1.5 text-start align-top";
/** Numbers line up on the right, in equal-width digits. */
const NUMERIC = "text-end tabular-nums";

interface ScrollEdges {
  /** The table is wider than its box, so the box scrolls. */
  readonly overflows: boolean;
  /** Columns are hidden before the visible part (scrolled away from the start). */
  readonly moreStart: boolean;
  /** Columns are hidden after the visible part. */
  readonly moreEnd: boolean;
}

const FITS: ScrollEdges = { overflows: false, moreStart: false, moreEnd: false };

function edgesOf(node: HTMLElement): ScrollEdges {
  const hidden = node.scrollWidth - node.clientWidth;
  if (hidden <= 1) return FITS;
  // Right-to-left boxes report scrollLeft ≤ 0, so its size is the distance from the start.
  const scrolled = Math.abs(node.scrollLeft);
  return { overflows: true, moreStart: scrolled > 1, moreEnd: scrolled < hidden - 1 };
}

const sameEdges = (a: ScrollEdges, b: ScrollEdges) =>
  a.overflows === b.overflows && a.moreStart === b.moreStart && a.moreEnd === b.moreEnd;

/** Whether `el` is wider than its box and which way it can scroll, kept current on resize and scroll. */
function useScrollEdges(el: RefObject<HTMLElement | null>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>(FITS);
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const measure = () => {
      const next = edgesOf(node);
      setEdges((current) => (sameEdges(current, next) ? current : next));
    };
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    const table = node.firstElementChild;
    if (table) observer?.observe(table);
    return () => {
      node.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [el]);
  return edges;
}

/** Fades the edge a wide table continues past, so a cut column reads as "scroll for more". */
const EDGE_HINT = "pointer-events-none absolute inset-y-0 w-6 from-console-bg to-transparent";

/**
 * A data table that scrolls sideways on narrow screens instead of the page. The caption names it;
 * `hideCaption` keeps the name for assistive tech when a visible heading already says it. Only
 * while the table is wider than its box does the wrapper become a named, focusable scroll region
 * (so it can be scrolled with the arrow keys), so a page of tables that fit has no extra tab stops
 * or landmarks; then a fade marks each edge with more columns past it (KOBE-306). The scroll box
 * is positioned, so visually hidden cell text (`sr-only`) stays inside it and never widens the
 * page. Column headers are `TableHeader` (scope col), row headers `TableRowHeader`.
 */
export function Table({
  caption,
  hideCaption = false,
  children,
  className,
  ...props
}: ComponentProps<"table"> & {
  readonly caption?: ReactNode;
  readonly hideCaption?: boolean;
}) {
  const name = typeof caption === "string" ? caption : undefined;
  const wrapper = useRef<HTMLDivElement>(null);
  const { overflows, moreStart, moreEnd } = useScrollEdges(wrapper);
  return (
    <div className="relative">
      <div
        ref={wrapper}
        data-slot="console-table"
        className={cn("relative overflow-x-auto", FOCUS_RING)}
        {...(name && overflows ? { role: "region", "aria-label": name, tabIndex: 0 } : {})}
      >
        <table className={cn("w-full border-collapse", className)} {...props}>
          {caption && (
            <caption className={cn("pb-2 text-start font-semibold", hideCaption && "sr-only")}>
              {caption}
            </caption>
          )}
          {children}
        </table>
      </div>
      {moreStart && (
        <span
          aria-hidden
          data-edge="start"
          className={cn(EDGE_HINT, "start-0 bg-linear-to-r rtl:bg-linear-to-l")}
        />
      )}
      {moreEnd && (
        <span
          aria-hidden
          data-edge="end"
          className={cn(EDGE_HINT, "end-0 bg-linear-to-l rtl:bg-linear-to-r")}
        />
      )}
    </div>
  );
}

export function TableHead(props: ComponentProps<"thead">) {
  return <thead {...props} />;
}

export function TableBody(props: ComponentProps<"tbody">) {
  return <tbody {...props} />;
}

export function TableRow(props: ComponentProps<"tr">) {
  return <tr {...props} />;
}

type CellProps = { readonly numeric?: boolean };

export function TableHeader({
  className,
  scope = "col",
  numeric = false,
  ...props
}: ComponentProps<"th"> & CellProps) {
  return (
    <th
      scope={scope}
      className={cn(CELL, "font-semibold", numeric && NUMERIC, className)}
      {...props}
    />
  );
}

export function TableRowHeader({ className, ...props }: ComponentProps<"th">) {
  return <th scope="row" className={cn(CELL, "font-semibold", className)} {...props} />;
}

export function TableCell({
  className,
  numeric = false,
  ...props
}: ComponentProps<"td"> & CellProps) {
  return <td className={cn(CELL, numeric && NUMERIC, className)} {...props} />;
}

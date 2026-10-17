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

/** Whether `el` is wider than its box, now and whenever its size changes. */
function useOverflows(el: RefObject<HTMLElement | null>): boolean {
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const measure = () => setOverflows(node.scrollWidth > node.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    const table = node.firstElementChild;
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, [el]);
  return overflows;
}

/**
 * A data table that scrolls sideways on narrow screens instead of the page. The caption names it;
 * `hideCaption` keeps the name for assistive tech when a visible heading already says it. Only
 * while the table is wider than its box does the wrapper become a named, focusable scroll region
 * (so it can be scrolled with the arrow keys), so a page of tables that fit has no extra tab stops
 * or landmarks. Column headers are `TableHeader` (scope col), row headers `TableRowHeader`.
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
  const scrolls = useOverflows(wrapper);
  return (
    <div
      ref={wrapper}
      data-slot="console-table"
      className={cn("overflow-x-auto", FOCUS_RING)}
      {...(name && scrolls ? { role: "region", "aria-label": name, tabIndex: 0 } : {})}
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

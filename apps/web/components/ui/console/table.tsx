import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../../lib/utils";
import { FOCUS_RING } from "./focus";

const CELL = "border-b border-console-border px-2.5 py-1.5 text-start align-top";
/** Numbers line up on the right, in equal-width digits. */
const NUMERIC = "text-end tabular-nums";

/**
 * A data table that scrolls sideways on narrow screens instead of the page. The caption names it
 * (and its scroll region, which takes keyboard focus so it can be scrolled with the arrow keys);
 * `hideCaption` keeps the name for assistive tech when a visible heading already says it. Column
 * headers are `TableHeader` (scope col), row headers `TableRowHeader`.
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
  return (
    <div
      data-slot="console-table"
      className={cn("overflow-x-auto", FOCUS_RING)}
      {...(name ? { role: "region", "aria-label": name, tabIndex: 0 } : {})}
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

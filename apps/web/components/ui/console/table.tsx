import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../../lib/utils";

const CELL = "border-b border-console-border px-2.5 py-1.5 text-left align-top";

/**
 * A data table that scrolls sideways on narrow screens instead of the page. The caption names it
 * for assistive tech; column headers are `TableHeader` (scope col), row headers `TableRowHeader`.
 */
export function Table({
  caption,
  children,
  className,
  ...props
}: ComponentProps<"table"> & { readonly caption?: ReactNode }) {
  return (
    <div data-slot="console-table" className="overflow-x-auto">
      <table className={cn("w-full border-collapse", className)} {...props}>
        {caption && <caption className="pb-2 text-left font-semibold">{caption}</caption>}
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

export function TableHeader({ className, scope = "col", ...props }: ComponentProps<"th">) {
  return <th scope={scope} className={cn(CELL, "font-semibold", className)} {...props} />;
}

export function TableRowHeader({ className, ...props }: ComponentProps<"th">) {
  return <th scope="row" className={cn(CELL, "font-semibold", className)} {...props} />;
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn(CELL, className)} {...props} />;
}

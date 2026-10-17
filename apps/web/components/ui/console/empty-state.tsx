import type { ReactNode } from "react";
import { cn } from "../../../lib/utils";

/** What a list shows when it has nothing yet, and how to add the first item. */
export function EmptyState({
  title,
  children,
  action,
  className,
}: {
  readonly title: ReactNode;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      data-slot="console-empty"
      className={cn(
        "box-border rounded-lg border border-dashed border-console-border px-4 py-6 text-center",
        className,
      )}
    >
      <p className="m-0 font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-console-muted">{children}</div>}
      {action && <div className="mt-3 flex justify-center gap-2">{action}</div>}
    </div>
  );
}

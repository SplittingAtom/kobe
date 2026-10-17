import type { ReactNode } from "react";
import { cn } from "../../../lib/utils";

/** A console page's title (the page's only h1), what it is for, and its page-wide actions. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  return (
    <header
      data-slot="console-page-header"
      className={cn("mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2", className)}
    >
      <div className="min-w-0">
        <h1 className="m-0 text-3xl leading-tight font-bold">{title}</h1>
        {description && <p className="m-0 mt-2 text-console-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

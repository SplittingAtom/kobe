import type { ReactNode } from "react";
import { cn } from "../../../lib/utils";
import { PageHeaderText } from "./embedded-context";

/**
 * A console page's title (the page's only h1), what it is for, and its page-wide actions. `back`
 * is a link up for detail pages ("All agents"), shown above the title. Usable from Server
 * Components: the title and description go through the client `PageHeaderText`, which leaves the
 * title out on a page embedded beside the thread (KOBE-424).
 */
export function PageHeader({
  title,
  description,
  actions,
  back,
  className,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly back?: ReactNode;
  readonly className?: string;
}) {
  return (
    <header
      data-slot="console-page-header"
      className={cn("mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2", className)}
    >
      <div className="min-w-0">
        {back && <p className="m-0 mb-1 text-sm">{back}</p>}
        <PageHeaderText title={title} description={description} />
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

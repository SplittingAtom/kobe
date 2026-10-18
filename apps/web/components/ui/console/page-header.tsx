import { createContext, useContext, type ReactNode } from "react";
import { cn } from "../../../lib/utils";

/**
 * Embedded beside the thread (CE4, KOBE-424), a My area page sits under its panel's own heading
 * (the area's name): the page's title is left out there; its description and actions stay.
 */
export const EmbeddedPage = createContext(false);

/**
 * A console page's title (the page's only h1), what it is for, and its page-wide actions. `back`
 * is a link up for detail pages ("All agents"), shown above the title.
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
  const embedded = useContext(EmbeddedPage);
  return (
    <header
      data-slot="console-page-header"
      className={cn("mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2", className)}
    >
      <div className="min-w-0">
        {back && <p className="m-0 mb-1 text-sm">{back}</p>}
        {!embedded && <h1 className="m-0 text-3xl leading-tight font-bold">{title}</h1>}
        {description && (
          <p className={cn("m-0 text-console-muted", !embedded && "mt-2")}>{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

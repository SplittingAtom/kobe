import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "../../../lib/utils";

type Level = 2 | 3 | 4;
const HEADING = { 2: "h2", 3: "h3", 4: "h4" } as const;

/**
 * A titled part of a page: a `section` landmark named by its heading (h2; `level` 3 or 4 inside
 * another section). `id` sets the heading's id; the heading takes focus from code (tabIndex -1),
 * so a page can move focus to it after the item it held goes away.
 */
export function Section({
  id,
  title,
  level = 2,
  description,
  actions,
  children,
  className,
}: {
  readonly id?: string;
  readonly title: ReactNode;
  readonly level?: Level;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
}) {
  const generated = useId();
  const headingId = id ?? generated;
  const Heading = HEADING[level];
  return (
    <section
      data-slot="console-section"
      aria-labelledby={headingId}
      className={cn("mt-6", className)}
    >
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <Heading
            id={headingId}
            tabIndex={-1}
            className={cn(
              "m-0 leading-snug font-semibold focus:outline-none",
              level === 2 ? "text-xl" : "text-lg",
            )}
          >
            {title}
          </Heading>
          {description && <p className="m-0 mt-1 text-sm text-console-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** A bordered panel on the page, with an optional title (h3 unless `level` says otherwise). */
export function Card({
  title,
  level = 3,
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  readonly title?: ReactNode;
  readonly level?: Level;
}) {
  const Heading = HEADING[level];
  return (
    <div
      data-slot="console-card"
      className={cn(
        "box-border rounded-lg border border-console-border bg-console-bg p-3",
        className,
      )}
      {...props}
    >
      {title && <Heading className="m-0 mb-2 text-base font-semibold">{title}</Heading>}
      {children}
    </div>
  );
}

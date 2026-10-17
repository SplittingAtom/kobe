import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "../../../lib/utils";

/** A titled part of a page: a `section` landmark named by its h2. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
}) {
  const id = useId();
  return (
    <section data-slot="console-section" aria-labelledby={id} className={cn("mt-6", className)}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 id={id} className="m-0 text-xl leading-snug font-semibold">
            {title}
          </h2>
          {description && <p className="m-0 mt-1 text-sm text-console-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** A bordered panel on the page. */
export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="console-card"
      className={cn(
        "box-border rounded-lg border border-console-border bg-console-bg p-3",
        className,
      )}
      {...props}
    />
  );
}

import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../../lib/utils";

/**
 * The frame of the Site console, the Team console and the My area (KOBE-294): a skip link, a
 * header (brand and switcher at the start, who is signed in and the theme toggle at the end), the
 * optional section navigation and the page. `data-kobe-console` marks the root: the console
 * stylesheet's scoped rules (app/admin/admin-global.css) and the console's portals hang off it.
 */
export function ConsoleLayout({
  brand,
  headerStart,
  headerEnd,
  nav,
  children,
}: {
  readonly brand: ReactNode;
  readonly headerStart?: ReactNode;
  readonly headerEnd?: ReactNode;
  /** The section navigation; without it the page takes the full width. */
  readonly nav?: ReactNode;
  /** The page: a `ConsoleMain`. */
  readonly children: ReactNode;
}) {
  return (
    <div
      data-kobe-console=""
      className="min-h-screen bg-console-bg font-sans leading-normal text-console-fg"
    >
      <a
        href="#console-main"
        className="sr-only focus:not-sr-only focus:inline-block focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <header className="box-border flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-0 border-b border-console-border px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <p className="m-0">{brand}</p>
          {headerStart}
        </div>
        <div className="flex items-center gap-3">{headerEnd}</div>
      </header>
      <div
        className={cn(
          "grid grid-cols-[minmax(0,1fr)]",
          nav !== undefined && "md:grid-cols-[15rem_minmax(0,1fr)]",
        )}
      >
        {nav}
        {children}
      </div>
    </div>
  );
}

/** The page's landmark, the skip link's target; focusable so navigation can move focus to it. */
export function ConsoleMain({ className, ...props }: ComponentProps<"main">) {
  return (
    <main
      id="console-main"
      className={cn("box-border max-w-5xl p-4 focus:outline-none md:px-8 md:py-6", className)}
      {...props}
    />
  );
}

/** The signed-in person (and their site role) in the header. */
export function ConsoleWho({ children }: { readonly children: ReactNode }) {
  return <p className="m-0 text-console-muted">{children}</p>;
}

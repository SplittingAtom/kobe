"use client";

import Link from "next/link";
import { createContext, useContext, useState, type ReactNode } from "react";
import { cn } from "../../../lib/utils";
import { Button } from "./button";
import { FOCUS_RING } from "./focus";

const CloseContext = createContext<() => void>(() => undefined);

/**
 * A console's section navigation. Narrow screens fold the list behind a toggle (so the page comes
 * first) that names the current section; wide screens show it as a sidebar. Following a link
 * folds it again.
 */
export function SideNav({
  label,
  toggleLabel,
  listId,
  children,
}: {
  /** The landmark's name: "Site console sections". */
  readonly label: string;
  /** The narrow-screen toggle's text: "Section: Users". */
  readonly toggleLabel: string;
  readonly listId: string;
  /** `SideNavGroup`s. */
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <nav
      aria-label={label}
      className="box-border border-0 border-b border-console-border bg-console-panel px-4 pt-2 pb-4 md:min-h-[calc(100vh-3.5rem)] md:border-r md:border-b-0"
    >
      <Button
        className="mt-2 md:hidden"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        {toggleLabel}
      </Button>
      <div id={listId} className={cn(!open && "max-md:hidden")}>
        <CloseContext.Provider value={() => setOpen(false)}>{children}</CloseContext.Provider>
      </div>
    </nav>
  );
}

/** A titled group of links: its heading names the list. */
export function SideNavGroup({
  id,
  heading,
  children,
}: {
  /** The heading's id (unique on the page). */
  readonly id: string;
  readonly heading: ReactNode;
  /** `SideNavLink`s. */
  readonly children: ReactNode;
}) {
  return (
    <div>
      <h2
        id={id}
        className="mt-4 mb-1 text-xs font-bold tracking-[0.06em] text-console-muted uppercase"
      >
        {heading}
      </h2>
      <ul aria-labelledby={id} className="m-0 list-none p-0">
        {children}
      </ul>
    </div>
  );
}

/** One section link; the current one is marked for assistive tech and drawn with a bar. */
export function SideNavLink({
  href,
  current,
  children,
}: {
  readonly href: string;
  readonly current: boolean;
  readonly children: ReactNode;
}) {
  const close = useContext(CloseContext);
  return (
    <li>
      <Link
        href={href}
        onClick={close}
        aria-current={current ? "page" : undefined}
        className={`block rounded-md px-2 py-[0.3rem] text-console-accent no-underline aria-[current=page]:bg-console-bg aria-[current=page]:font-semibold aria-[current=page]:shadow-[inset_3px_0_0_var(--admin-accent)] ${FOCUS_RING}`}
      >
        {children}
      </Link>
    </li>
  );
}

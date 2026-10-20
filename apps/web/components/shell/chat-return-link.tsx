"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { lastThreadHref } from "../../lib/shell/last-thread";
import { fetchMyTeams } from "../../lib/teams";
import { usePanelClose } from "./panel-close";

/**
 * In a panel over the workspace (KOBE-452) it closes the panel, as Close does (no history entry,
 * unsaved edits asked about first); the address stays a link for a new tab.
 *
 * The link from a full-page route (console, builder) back to the chat, onto the thread that was
 * open (CE4) if it belongs to the session's active team. "/" until that is known, or if it can't be.
 */
export function ChatReturnLink({ children }: { readonly children: ReactNode }) {
  const closePanel = usePanelClose();
  const [href, setHref] = useState("/");
  useEffect(() => {
    let current = true;
    fetchMyTeams().then(
      (my) => {
        if (current) setHref(lastThreadHref(my?.activeTeamId ?? null));
      },
      () => undefined, // the plain way back ("/") stays
    );
    return () => {
      current = false;
    };
  }, []);
  if (closePanel) {
    return (
      <Link
        href={href}
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          closePanel();
        }}
      >
        {children}
      </Link>
    );
  }
  return <Link href={href}>{children}</Link>;
}

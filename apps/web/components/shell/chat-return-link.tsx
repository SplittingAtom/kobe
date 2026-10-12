"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { lastThreadHref } from "../../lib/shell/last-thread";
import { fetchMyTeams } from "../../lib/teams";

/**
 * The link from a full-page route (console, builder) back to the chat, onto the thread that was
 * open (CE4) if it belongs to the session's active team. "/" until that is known, or if it can't be.
 */
export function ChatReturnLink({ children }: { readonly children: ReactNode }) {
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
  return <Link href={href}>{children}</Link>;
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchInstallAccess, fetchTeamAccess } from "../../lib/admin/api/access";
import { canOpenConsole, consoleHref } from "../../lib/admin/nav/registry";
import type { ConsoleKind } from "../../lib/admin/nav/types";
import { ACTIVE_TEAM_EVENT } from "../../lib/teams";

/**
 * Links to the admin consoles the caller can open, decided from the server's answer about their
 * roles. Hiding a link is a convenience; the consoles and their APIs check again.
 */
export function ConsoleLinks() {
  const [open, setOpen] = useState<readonly ConsoleKind[]>([]);

  const [attempt, setAttempt] = useState(0);

  // The switcher may activate a team after we asked: ask again then.
  useEffect(() => {
    const retry = () => setAttempt((n) => n + 1);
    window.addEventListener(ACTIVE_TEAM_EVENT, retry);
    return () => window.removeEventListener(ACTIVE_TEAM_EVENT, retry);
  }, []);

  useEffect(() => {
    let current = true;
    Promise.all([fetchInstallAccess(), fetchTeamAccess()]).then(
      ([install, team]) => {
        if (!current) return;
        const kinds: ConsoleKind[] = [];
        if (install.ok && canOpenConsole(install.data)) kinds.push("install");
        if (team.ok && canOpenConsole(team.data)) kinds.push("team");
        setOpen(kinds);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  if (open.length === 0) return null;
  return (
    <nav aria-label="Administration">
      <ul>
        {open.includes("install") && (
          <li>
            <Link href={consoleHref("install")}>Install console</Link>
          </li>
        )}
        {open.includes("team") && (
          <li>
            <Link href={consoleHref("team")}>Team console</Link>
          </li>
        )}
      </ul>
    </nav>
  );
}

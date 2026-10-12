"use client";

import { createContext, useContext } from "react";
import type { ConsoleAccess, SiteAccess, TeamAccess } from "../../lib/admin/nav/types";

/** The caller's access as the server reported it when the console shell loaded. */
export const ConsoleAccessContext = createContext<ConsoleAccess | null>(null);

export function useSiteAccess(): SiteAccess {
  const access = useContext(ConsoleAccessContext);
  if (access?.console !== "site") throw new Error("useSiteAccess outside the site console");
  return access;
}

export function useTeamAccess(): TeamAccess {
  const access = useContext(ConsoleAccessContext);
  if (access?.console !== "team") throw new Error("useTeamAccess outside the team console");
  return access;
}

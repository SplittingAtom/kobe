"use client";

import { createContext, useContext } from "react";
import type { ConsoleAccess, InstallAccess, TeamAccess } from "../../lib/admin/nav/types";

/** The caller's access as the server reported it when the console shell loaded. */
export const ConsoleAccessContext = createContext<ConsoleAccess | null>(null);

export function useInstallAccess(): InstallAccess {
  const access = useContext(ConsoleAccessContext);
  if (access?.console !== "install")
    throw new Error("useInstallAccess outside the install console");
  return access;
}

export function useTeamAccess(): TeamAccess {
  const access = useContext(ConsoleAccessContext);
  if (access?.console !== "team") throw new Error("useTeamAccess outside the team console");
  return access;
}

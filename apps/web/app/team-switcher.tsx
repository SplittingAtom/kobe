"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ACTIVE_TEAM_EVENT,
  LAST_TEAM_KEY,
  fetchMyTeams,
  roleLabel,
  setActiveTeam,
  teamToActivate,
  type MyTeams,
} from "../lib/teams";
import { forgetLastThread } from "../lib/shell/last-thread";
import { barMenuProps } from "../components/shell/bar-menu";

function remember(teamId: string): void {
  try {
    localStorage.setItem(LAST_TEAM_KEY, teamId);
  } catch {
    // Storage blocked: the server still holds the active team for this session.
  }
}

function remembered(): string | null {
  try {
    return localStorage.getItem(LAST_TEAM_KEY);
  } catch {
    return null;
  }
}

/** The caller's teams, any load error, and the switch (sets the active team, then reloads). */
export interface MyTeamsState {
  readonly my: MyTeams | null;
  readonly error: string | null;
  readonly switchTo: (teamId: string) => Promise<void>;
}

/**
 * The caller's teams (spec D9). With `activate`, a session with no active team gets one on load
 * (the remembered team, else the first) and the views waiting for it are told (ACTIVE_TEAM_EVENT).
 * Switching reloads so every team-scoped view refetches under the new team.
 */
export function useMyTeams(activate: boolean): MyTeamsState {
  const [my, setMy] = useState<MyTeams | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const teams = await fetchMyTeams();
      if (cancelled || teams === null) return;
      const pick = activate ? teamToActivate(teams, remembered()) : null;
      if (pick !== null) {
        await setActiveTeam(pick);
        remember(pick);
        if (!cancelled) setMy({ ...teams, activeTeamId: pick });
        // Views that asked for the active team before this one existed ask again.
        window.dispatchEvent(new Event(ACTIVE_TEAM_EVENT));
      } else if (!cancelled) setMy(teams);
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : "Could not load your teams.");
    });
    return () => {
      cancelled = true;
    };
  }, [activate]);

  const switchTo = useCallback(async (teamId: string) => {
    try {
      await setActiveTeam(teamId);
      remember(teamId);
      forgetLastThread(); // it belongs to the team being left (CE4)
      window.location.reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not switch teams.");
    }
  }, []);
  return { my, error, switchTo };
}

/** Class names for a placement of the menu (the rail's top line styles it, KOBE-419). */
export interface TeamMenuClasses {
  readonly nav?: string | undefined;
  readonly summary?: string | undefined;
  readonly name?: string | undefined;
  readonly list?: string | undefined;
}

/**
 * The teams as a disclosure menu: the active one named (with its role) on the summary, each team
 * with its role in the list, the active one marked and disabled.
 */
export function TeamMenu({
  my,
  switchTo,
  classes = {},
}: {
  readonly my: MyTeams;
  readonly switchTo: (teamId: string) => Promise<void>;
  readonly classes?: TeamMenuClasses;
}) {
  const active = my.teams.find((t) => t.id === my.activeTeamId);
  return (
    <nav aria-label="Teams" className={classes.nav}>
      <details {...barMenuProps}>
        <summary className={classes.summary} title={active?.name}>
          <span className={classes.name}>{active ? active.name : "Choose a team"}</span>
          {active && <small> · {roleLabel(active.role)}</small>}
        </summary>
        <ul className={classes.list}>
          {my.teams.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                aria-current={t.id === my.activeTeamId ? "true" : undefined}
                disabled={t.id === my.activeTeamId}
                onClick={() => void switchTo(t.id)}
              >
                {t.name} <small>{roleLabel(t.role)}</small>
              </button>
            </li>
          ))}
        </ul>
      </details>
    </nav>
  );
}

/**
 * The consoles' team switcher (spec D9): lists the user's teams with their role and sets the
 * session's one active team. In the chat it sits on the rail's top line (KOBE-419,
 * `components/shell/rail-team.tsx`), and `TeamActivation` activates a team on load there.
 */
export function TeamSwitcher() {
  const { my, error, switchTo } = useMyTeams(true);
  if (error) return <p role="alert">{error}</p>;
  if (my === null) return null;
  if (my.teams.length === 0) {
    return <p>You are not in any team yet. Ask an admin to add you to one.</p>;
  }
  return <TeamMenu my={my} switchTo={switchTo} />;
}

/**
 * The chat's first load (KOBE-419): with no active team, activates one as the switcher did from
 * the bar, before the rail (which holds the selector now) can render. Shows only an error.
 */
export function TeamActivation() {
  const { error } = useMyTeams(true);
  return error ? <p role="alert">{error}</p> : null;
}

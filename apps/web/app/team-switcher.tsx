"use client";

import { useEffect, useState } from "react";
import {
  LAST_TEAM_KEY,
  fetchMyTeams,
  roleLabel,
  setActiveTeam,
  teamToActivate,
  type MyTeams,
} from "../lib/teams";

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

/**
 * Top-left team switcher (spec D9): lists the user's teams with their role and sets the session's
 * one active team. Switching reloads so every team-scoped view refetches under the new team.
 */
export function TeamSwitcher() {
  const [my, setMy] = useState<MyTeams | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const teams = await fetchMyTeams();
      if (cancelled || teams === null) return;
      const pick = teamToActivate(teams, remembered());
      if (pick !== null) {
        await setActiveTeam(pick);
        remember(pick);
        if (!cancelled) setMy({ ...teams, activeTeamId: pick });
      } else if (!cancelled) setMy(teams);
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : "Could not load your teams.");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function switchTo(teamId: string) {
    try {
      await setActiveTeam(teamId);
      remember(teamId);
      window.location.reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not switch teams.");
    }
  }

  if (error) return <p role="alert">{error}</p>;
  if (my === null) return null;
  if (my.teams.length === 0) {
    return <p>You are not in any team yet. Ask an admin to add you to one.</p>;
  }
  const active = my.teams.find((t) => t.id === my.activeTeamId);
  return (
    <nav aria-label="Teams">
      <details>
        <summary>
          {active ? active.name : "Choose a team"}
          {active && <small> · {roleLabel(active.role)}</small>}
        </summary>
        <ul>
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

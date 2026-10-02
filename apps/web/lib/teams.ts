/** Team switcher client logic (spec D9). The server stays authoritative on membership. */

export type TeamRole = "team_admin" | "builder" | "member";

export interface TeamOption {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly role: TeamRole;
}

export interface MyTeams {
  readonly activeTeamId: string | null;
  readonly teams: readonly TeamOption[];
}

/** Sent on team-scoped requests; the server refuses it if another tab switched teams meanwhile. */
export const TEAM_HEADER = "x-kobe-team";

/** Remembers this browser's last team so a new sign-in lands there (a convenience only). */
export const LAST_TEAM_KEY = "kobe.lastTeamId";

const ROLE_LABELS: Readonly<Record<TeamRole, string>> = {
  team_admin: "Team admin",
  builder: "Builder",
  member: "Member",
};

export function roleLabel(role: TeamRole): string {
  return ROLE_LABELS[role];
}

/** The team to activate on load: none if one is active, else the remembered team, else the first. */
export function teamToActivate(my: MyTeams, remembered: string | null): string | null {
  if (my.activeTeamId !== null || my.teams.length === 0) return null;
  return my.teams.find((t) => t.id === remembered)?.id ?? my.teams[0]?.id ?? null;
}

/** The caller's teams, or null when signed out. */
export async function fetchMyTeams(fetchFn: typeof fetch = fetch): Promise<MyTeams | null> {
  const res = await fetchFn("/v1/me/teams");
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Could not load your teams (HTTP ${res.status}).`);
  return (await res.json()) as MyTeams;
}

export async function setActiveTeam(teamId: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn("/v1/me/teams/active", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ teamId }),
  });
  if (!res.ok) throw new Error(`Could not switch teams (HTTP ${res.status}).`);
}

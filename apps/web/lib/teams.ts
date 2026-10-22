/** Team switcher client logic (spec D9). The server stays authoritative on membership. */

export type TeamRole = "team_admin" | "builder" | "member";

export interface TeamOption {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly role: TeamRole;
  /** The Site's Registry team (Skill review), not a working team. */
  readonly registry: boolean;
  /** Chat can run there: the team has a model enabled. */
  readonly chatReady: boolean;
}

export interface MyTeams {
  readonly activeTeamId: string | null;
  /** The team the user last made active in any session, while still a member (KOBE-456). */
  readonly lastTeamId: string | null;
  readonly teams: readonly TeamOption[];
}

/** Sent on team-scoped requests; the server refuses it if another tab switched teams meanwhile. */
export const TEAM_HEADER = "x-kobe-team";

/** Window event fired after the switcher activates a team on load (consoles re-check access). */
export const ACTIVE_TEAM_EVENT = "kobe:active-team";

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

/**
 * The team to activate on load (KOBE-456): none if one is active; else the user's last team (the
 * server's, then this browser's), while still a member; else the first working team (not the
 * Registry) where chat can run, else the first working team, else the first by name.
 */
export function teamToActivate(my: MyTeams, remembered: string | null): string | null {
  if (my.activeTeamId !== null) return null;
  const member = (id: string | null) => my.teams.find((t) => t.id === id);
  const working = my.teams.filter((t) => !t.registry);
  const pick =
    member(my.lastTeamId) ??
    member(remembered) ??
    working.find((t) => t.chatReady) ??
    working[0] ??
    my.teams[0];
  return pick?.id ?? null;
}

/** Reads one team of `/v1/me/teams`; an answer without the hints is a plain working team. */
function teamOption(raw: TeamOption): TeamOption {
  return { ...raw, registry: raw.registry === true, chatReady: raw.chatReady !== false };
}

/** The caller's teams, or null when signed out. */
export async function fetchMyTeams(fetchFn: typeof fetch = fetch): Promise<MyTeams | null> {
  const res = await fetchFn("/v1/me/teams");
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Could not load your teams (HTTP ${res.status}).`);
  const body = (await res.json()) as Partial<MyTeams>;
  return {
    activeTeamId: body.activeTeamId ?? null,
    lastTeamId: body.lastTeamId ?? null,
    teams: (body.teams ?? []).map(teamOption),
  };
}

export async function setActiveTeam(teamId: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn("/v1/me/teams/active", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ teamId }),
  });
  if (!res.ok) throw new Error(`Could not switch teams (HTTP ${res.status}).`);
}

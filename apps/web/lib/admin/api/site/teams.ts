/** Site console: teams (`/v1/site`, site.teams.manage). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";

const enc = encodeURIComponent;

export interface SiteTeam {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly createdAt?: string;
}

export interface RosterMember {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: "team_admin" | "builder" | "member";
  readonly joinedAt: string;
}

/** Mirrors the server's team slug rule (it names the `kobe-team-<slug>` namespace). */
export const TEAM_SLUG_PATTERN = "[a-z0-9]([a-z0-9\\-]{0,30}[a-z0-9])?";

export async function listSiteTeams(): Promise<ApiResult<readonly SiteTeam[]>> {
  const res = await apiRequest<{ teams: SiteTeam[] }>("/v1/site/teams");
  return res.ok ? { ...res, data: res.data.teams } : res;
}

export async function createTeam(input: {
  slug: string;
  name: string;
  adminUserId: string;
}): Promise<ApiResult<SiteTeam>> {
  const res = await apiRequest<{ team: SiteTeam }>("/v1/site/teams", {
    method: "POST",
    json: { slug: input.slug, name: input.name, adminUserId: input.adminUserId },
  });
  return res.ok ? { ...res, data: res.data.team } : res;
}

export async function renameTeam(teamId: string, name: string): Promise<ApiResult<SiteTeam>> {
  const res = await apiRequest<{ team: SiteTeam }>(`/v1/site/teams/${enc(teamId)}`, {
    method: "PATCH",
    json: { name },
  });
  return res.ok ? { ...res, data: res.data.team } : res;
}

export async function teamRoster(teamId: string): Promise<ApiResult<readonly RosterMember[]>> {
  const res = await apiRequest<{ members: RosterMember[] }>(
    `/v1/site/teams/${enc(teamId)}/members`,
  );
  return res.ok ? { ...res, data: res.data.members } : res;
}

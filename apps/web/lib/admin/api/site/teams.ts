/** Site console: teams (`/v1/site`, site.teams.manage). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { TeamRole } from "../../../teams";

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
  readonly role: "team_admin" | "contributor" | "member";
  readonly joinedAt: string;
  /**
   * Kobe added them to the Registry team for the Skill reviewer grant (KOBE-331), or an identity
   * provider's access mappings manage the row (`idp`, KOBE-627), or a Site admin added them from
   * the Site console (`site_admin`, KOBE-638). Null: an invitation (or the first team admin).
   * Older servers omit it.
   */
  readonly addedVia?: "skill_reviewer_grant" | "idp" | "site_admin" | null;
  /** The account is deactivated (it stays a member); older servers omit it. */
  readonly deactivated?: boolean;
  /** The provider whose mappings manage the row (KOBE-627, SSO10); older servers omit it. */
  readonly managedBy?: { readonly providerId: string; readonly providerName: string } | null;
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

/** An active user who is not in the team yet (KOBE-638); never the caller. */
export interface MemberCandidate {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
}

export async function searchMemberCandidates(
  teamId: string,
  query: string,
): Promise<ApiResult<readonly MemberCandidate[]>> {
  const q = query.trim() === "" ? "" : `?q=${enc(query.trim())}`;
  const res = await apiRequest<{ candidates: MemberCandidate[] }>(
    `/v1/site/teams/${enc(teamId)}/candidates${q}`,
  );
  return res.ok ? { ...res, data: res.data.candidates } : res;
}

/** Adds existing users at once, no invitation (KOBE-638). All or nothing. */
export function addTeamMembers(
  teamId: string,
  userIds: readonly string[],
  role: TeamRole,
): Promise<ApiResult<unknown>> {
  return apiRequest(`/v1/site/teams/${enc(teamId)}/members`, {
    method: "POST",
    json: { userIds, role },
  });
}

/**
 * `expectedRole`: the role the roster showed (review L2); the server refuses with 409
 * `changed_since_approval` when someone changed it since.
 */
export function setTeamMemberRole(
  teamId: string,
  userId: string,
  role: TeamRole,
  expectedRole: TeamRole,
): Promise<ApiResult<unknown>> {
  return apiRequest(`/v1/site/teams/${enc(teamId)}/members/${enc(userId)}`, {
    method: "PATCH",
    json: { role, expectedRole },
  });
}

export function removeTeamMember(
  teamId: string,
  userId: string,
  expectedRole: TeamRole,
): Promise<ApiResult<void>> {
  return apiRequest(
    `/v1/site/teams/${enc(teamId)}/members/${enc(userId)}?expectedRole=${enc(expectedRole)}`,
    { method: "DELETE" },
  );
}

/** Take over (SSO10) from the Site console: the provider stops managing the membership. */
export function takeOverTeamMember(teamId: string, userId: string): Promise<ApiResult<unknown>> {
  return apiRequest(`/v1/site/teams/${enc(teamId)}/members/${enc(userId)}/take-over`, {
    method: "POST",
  });
}

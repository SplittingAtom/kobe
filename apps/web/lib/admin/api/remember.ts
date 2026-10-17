/**
 * Remembered approvals (KOBE-289): the member's own rules (My area, Approvals), every member's in
 * the team (team Policy page, team admins), and the remember limits of the team and the site
 * floor. Responses arrive camelized (`argPattern` kept verbatim); bodies go in snake_case. The
 * server enforces every scope and limit; these pages list, revoke and set.
 */
import type { RememberScope } from "@kobe/protocol";
import { apiRequest, type ApiResult } from "../../api/client";

const enc = encodeURIComponent;

export interface MemberRule {
  readonly id: string;
  readonly userId: string;
  readonly userName: string;
  readonly toolGlob: string;
  /** JSON pointer → literal glob ("only this exact action"); null = any input, or masked. */
  readonly argPattern: Readonly<Record<string, string>> | null;
  /** The pattern's pointers: its shape, shown even when the values are masked. */
  readonly argPointers: readonly string[];
  readonly rememberScope: RememberScope;
  readonly threadId: string | null;
  readonly threadTitle: string | null;
  readonly runId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  /** Team Policy page: the member's thread and argument values are private (D18). */
  readonly masked: boolean;
  /** False when the server ignores the rule; `endedReason` says why. */
  readonly applies: boolean;
  readonly endedReason: string | null;
}

export interface RememberLimits {
  readonly scopes: readonly RememberScope[];
  readonly maxDurationSeconds: number | null;
  readonly mcpTools: boolean;
  readonly exactOnly: boolean;
  readonly approveAll: boolean;
}

export interface TeamRememberLimits {
  readonly site: RememberLimits;
  readonly team: RememberLimits;
  readonly effective: RememberLimits;
}

function limitsBody(l: RememberLimits) {
  return {
    scopes: [...l.scopes],
    max_duration_seconds: l.maxDurationSeconds,
    mcp_tools: l.mcpTools,
    exact_only: l.exactOnly,
    approve_all: l.approveAll,
  };
}

async function rules(path: string, teamId: string): Promise<ApiResult<readonly MemberRule[]>> {
  const res = await apiRequest<{ rules: MemberRule[] }>(path, { teamId });
  return res.ok ? { ...res, data: res.data.rules } : res;
}

/** The caller's own live remembered approvals in the team. */
export function listMyRules(teamId: string): Promise<ApiResult<readonly MemberRule[]>> {
  return rules("/v1/team/policy/my-rules", teamId);
}

export function revokeMyRule(teamId: string, id: string): Promise<ApiResult<void>> {
  return apiRequest(`/v1/team/policy/my-rules/${enc(id)}`, { method: "DELETE", teamId });
}

/** Every member's live remembered approvals in the team (team admins). */
export function listMemberRules(teamId: string): Promise<ApiResult<readonly MemberRule[]>> {
  return rules("/v1/team/policy/member-rules", teamId);
}

export function revokeMemberRule(teamId: string, id: string): Promise<ApiResult<void>> {
  return apiRequest(`/v1/team/policy/member-rules/${enc(id)}`, { method: "DELETE", teamId });
}

export function getTeamRememberLimits(teamId: string): Promise<ApiResult<TeamRememberLimits>> {
  return apiRequest("/v1/team/policy/remember-limits", { teamId });
}

export function putTeamRememberLimits(
  teamId: string,
  limits: RememberLimits,
): Promise<ApiResult<TeamRememberLimits>> {
  return apiRequest("/v1/team/policy/remember-limits", {
    method: "PUT",
    json: limitsBody(limits),
    teamId,
  });
}

export async function getSiteRememberLimits(): Promise<ApiResult<RememberLimits>> {
  const res = await apiRequest<{ limits: RememberLimits }>("/v1/site/policy/remember-limits");
  return res.ok ? { ...res, data: res.data.limits } : res;
}

export async function putSiteRememberLimits(
  limits: RememberLimits,
): Promise<ApiResult<RememberLimits>> {
  const res = await apiRequest<{ limits: RememberLimits }>("/v1/site/policy/remember-limits", {
    method: "PUT",
    json: limitsBody(limits),
  });
  return res.ok ? { ...res, data: res.data.limits } : res;
}

/** The member's stored time zone ("until end of today" ends at midnight there); null = UTC. */
export async function getTimeZone(): Promise<ApiResult<string | null>> {
  const res = await apiRequest<{ timeZone: string | null }>("/v1/me/time-zone");
  return res.ok ? { ...res, data: res.data.timeZone } : res;
}

export async function putTimeZone(timeZone: string | null): Promise<ApiResult<string | null>> {
  const res = await apiRequest<{ timeZone: string | null }>("/v1/me/time-zone", {
    method: "PUT",
    json: { time_zone: timeZone },
  });
  return res.ok ? { ...res, data: res.data.timeZone } : res;
}

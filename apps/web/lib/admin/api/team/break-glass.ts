/** Team console: break-glass on this team (`/v1/team/break-glass`, team.audit.read). */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { GrantStatus } from "../install/break-glass";

export interface TeamGrant {
  readonly id: string;
  readonly status: GrantStatus;
  readonly requestedBy: { readonly id: string; readonly name: string };
  readonly approvedBy: { readonly id: string; readonly name: string } | null;
  readonly selfApproved: boolean;
  readonly legalHold: boolean;
  /** `restricted` under a legal hold: the subject, thread and reason are not shown to the team. */
  readonly scope: "team" | "user" | "thread" | "restricted";
  readonly subject: { readonly id: string; readonly name: string } | null;
  readonly threadId: string | null;
  readonly reason: string | null;
  readonly startsAt: string | null;
  readonly expiresAt: string | null;
  readonly endedAt: string | null;
}

export interface TeamGrants {
  readonly active: readonly TeamGrant[];
  readonly recent: readonly TeamGrant[];
}

export function listTeamGrants(teamId: string): Promise<ApiResult<TeamGrants>> {
  return apiRequest<TeamGrants>("/v1/team/break-glass", { teamId });
}

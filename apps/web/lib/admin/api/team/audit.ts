/** Team console: the team's audit view (`/v1/team/audit`, team.audit.read; KOBE-15). */
import { apiRequest, type ApiResult } from "../../../api/client";

const enc = encodeURIComponent;

export interface TeamAuditEvent {
  readonly id: string;
  readonly seq: number;
  readonly at: string;
  readonly actor: {
    readonly kind: "user" | "agent" | "system";
    readonly id: string | null;
    readonly name: string | null;
    readonly email: string | null;
  };
  readonly action: string;
  readonly target: Record<string, unknown>;
}

export interface TeamAuditPage {
  readonly events: readonly TeamAuditEvent[];
  readonly nextCursor: string | null;
}

export function listTeamAudit(
  teamId: string,
  before?: string | null,
): Promise<ApiResult<TeamAuditPage>> {
  const query = before ? `&before=${enc(before)}` : "";
  return apiRequest<TeamAuditPage>(`/v1/team/audit?limit=50${query}`, { teamId });
}

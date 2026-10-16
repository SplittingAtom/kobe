/** Team console: chat settings (`/v1/team/settings`; read: members, change: team.models.manage; KOBE-222). */
import { apiRequest, type ApiResult } from "../../../api/client";

/** As read (the client camelizes the server's `followups_enabled`). */
export interface TeamChatSettings {
  /** Follow-up suggestions after each completed run (CE21); off by default. */
  readonly followupsEnabled: boolean;
}

export const getTeamSettings = (teamId: string): Promise<ApiResult<TeamChatSettings>> =>
  apiRequest("/v1/team/settings", { teamId });

export const putTeamSettings = (
  teamId: string,
  settings: TeamChatSettings,
): Promise<ApiResult<TeamChatSettings>> =>
  apiRequest("/v1/team/settings", {
    method: "PUT",
    json: { followups_enabled: settings.followupsEnabled },
    teamId,
  });

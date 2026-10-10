/** Team console: web search opt-in (`/v1/team/web-search`; read: members, change: team.connectors.manage; KOBE-113 API, KOBE-230 UI). */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { WebSearchProviderId } from "../install/web-search";

export interface TeamWebSearch {
  /** The install has an enabled provider; without one a team cannot opt in. */
  readonly available: boolean;
  readonly enabled: boolean;
  readonly provider: WebSearchProviderId | null;
}

export const getTeamWebSearch = (teamId: string): Promise<ApiResult<TeamWebSearch>> =>
  apiRequest("/v1/team/web-search", { teamId });

export const putTeamWebSearch = (
  teamId: string,
  enabled: boolean,
): Promise<ApiResult<TeamWebSearch>> =>
  apiRequest("/v1/team/web-search", { method: "PUT", json: { enabled }, teamId });

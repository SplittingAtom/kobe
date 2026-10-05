/** Team console: the pre-publish eval gate (`/v1/team/eval-settings`; read: members, change: team admins; KOBE-93). */
import { apiRequest, type ApiResult } from "../../../api/client";

export interface EvalSettings {
  readonly enabled: boolean;
  /** Publish is blocked above this attack success rate (0 to 1). */
  readonly maxAttackSuccessRate: number;
}

export const getEvalSettings = (teamId: string): Promise<ApiResult<EvalSettings>> =>
  apiRequest("/v1/team/eval-settings", { teamId });

export const putEvalSettings = (
  teamId: string,
  body: EvalSettings,
): Promise<ApiResult<EvalSettings>> =>
  apiRequest("/v1/team/eval-settings", { method: "PUT", json: body, teamId });

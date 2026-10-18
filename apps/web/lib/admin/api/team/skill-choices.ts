import { apiRequest, type ApiResult } from "../../../api/client";
import type { SkillAccess } from "./skills";

/**
 * A member's own skill choices in the active team (`/v1/me/skills/enablements`, KOBE-316): their
 * personal skills on or off here, and the team's skills and installs they turn on or off.
 */
export type ChoiceKind = "personal" | "team" | "catalog";

export interface PersonalChoice {
  readonly skillId: string;
  readonly name: string;
  readonly enabled: boolean;
}

export interface TeamChoice extends PersonalChoice {
  readonly access: SkillAccess;
}

export interface SkillChoices {
  readonly personal: readonly PersonalChoice[];
  readonly team: readonly TeamChoice[];
  readonly catalog: readonly TeamChoice[];
}

export function getSkillChoices(teamId: string): Promise<ApiResult<SkillChoices>> {
  return apiRequest("/v1/me/skills/enablements", { teamId });
}

export function setSkillChoice(
  teamId: string,
  choice: { readonly kind: ChoiceKind; readonly skillId: string; readonly enabled: boolean },
): Promise<ApiResult<{ enabled: boolean }>> {
  return apiRequest("/v1/me/skills/enablements", { method: "PUT", json: choice, teamId });
}

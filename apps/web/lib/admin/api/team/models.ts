/**
 * Team console and chat: the team's models (`/v1/team/models`; read with team.read, change with
 * team.models.manage; KOBE-40 API, KOBE-44 UI). The whole install catalog, each with whether the
 * team enabled it and which one is the team's default.
 */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { CatalogModel, ProviderKind } from "../install/models";

const enc = encodeURIComponent;
const BASE = "/v1/team/models";

export interface TeamModel extends CatalogModel {
  readonly enabled: boolean;
  readonly isDefault: boolean;
}

export interface TeamModels {
  readonly models: readonly TeamModel[];
  /** The team's default alias; null when it has none. */
  readonly default: string | null;
}

export type { ProviderKind };

export function listTeamModels(
  teamId: string,
  fetchFn?: typeof fetch,
): Promise<ApiResult<TeamModels>> {
  return apiRequest(BASE, { teamId, fetchFn });
}

/** Enables or disables a catalog model for the team; `isDefault` makes it the default. */
export function setTeamModel(
  teamId: string,
  alias: string,
  change: { readonly enabled: boolean; readonly isDefault?: boolean },
): Promise<ApiResult<TeamModels>> {
  return apiRequest(`${BASE}/${enc(alias)}`, {
    method: "PUT",
    json: {
      enabled: change.enabled,
      ...(change.isDefault === undefined ? {} : { is_default: change.isDefault }),
    },
    teamId,
  });
}

/** How a model is named to people: its label, else its alias. */
export function modelName(m: Pick<CatalogModel, "alias" | "label">): string {
  return m.label ?? m.alias;
}

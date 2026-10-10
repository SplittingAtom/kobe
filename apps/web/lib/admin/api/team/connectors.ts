/**
 * Team console: connector enablement and exposure (`/v1/team/connectors`; read with team.read,
 * change with team.connectors.manage; KOBE-104 API, KOBE-105 UI). Off by default: no row = off.
 */
import { apiRequest, type ApiResult } from "../../../api/client";

const BASE = "/v1/team/connectors";
const enc = encodeURIComponent;

export type Exposure = "read_only" | "all" | "custom";

export interface TeamConnectorTool {
  /** The name Pi sees; what a custom tick list stores. */
  readonly piName: string;
  readonly name: string;
  readonly title: string | null;
  readonly readOnly: boolean;
  /** MCP default is open-world, so an unannotated tool is write + open-world. */
  readonly openWorld: boolean;
  /** `drifted` tools are never offered until an install admin re-approves them (KOBE-102). */
  readonly status: "pinned" | "drifted";
}

export interface TeamConnector {
  readonly id: string;
  readonly name: string;
  readonly authKind: "oauth" | "api_key" | "none";
  /** The install admin's switch; a disabled connector cannot be enabled by a team. */
  readonly status: "active" | "disabled";
  readonly iconUrl: string | null;
  readonly enabled: boolean;
  readonly exposure: Exposure | null;
  readonly enabledTools: readonly string[];
  readonly tools: readonly TeamConnectorTool[];
}

export async function listTeamConnectors(
  teamId: string,
): Promise<ApiResult<readonly TeamConnector[]>> {
  const res = await apiRequest<{ connectors: readonly TeamConnector[] }>(BASE, { teamId });
  return res.ok ? { ...res, data: res.data.connectors } : res;
}

/** Enables the connector or changes its exposure; `enabledTools` only for `custom`. */
export async function setTeamConnector(
  teamId: string,
  id: string,
  exposure: Exposure,
  enabledTools: readonly string[],
): Promise<ApiResult<TeamConnector>> {
  const res = await apiRequest<{ connector: TeamConnector }>(`${BASE}/${enc(id)}`, {
    method: "PUT",
    json: exposure === "custom" ? { exposure, enabled_tools: enabledTools } : { exposure },
    teamId,
  });
  return res.ok ? { ...res, data: res.data.connector } : res;
}

export const disableTeamConnector = (teamId: string, id: string): Promise<ApiResult<unknown>> =>
  apiRequest(`${BASE}/${enc(id)}`, { method: "DELETE", teamId });

export const EXPOSURE_LABELS: Readonly<Record<Exposure, string>> = {
  read_only: "Read-only tools",
  all: "All tools",
  custom: "Chosen tools",
};

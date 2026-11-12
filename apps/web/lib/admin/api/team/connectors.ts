/**
 * Team console: connector enablement and exposure (`/v1/team/connectors`; read with team.read,
 * change with team.connectors.manage; KOBE-104 API, KOBE-105 UI). Off by default: no row = off.
 */
import { apiRequest, type ApiResult } from "../../../api/client";

const BASE = "/v1/team/connectors";
const enc = encodeURIComponent;

export type Exposure = "read_only" | "all" | "custom";

/**
 * A tool's MCP Apps template review (KOBE-640): `approved` renders; `pending` waits for a site
 * admin's review (KOBE-434); `missing`: no template of that URI is pinned for the connector;
 * `unknown`: the site panel could not load the templates (web only).
 */
export type ToolAppReview = "approved" | "pending" | "missing" | "unknown";

/** The template a tool opens (`_meta.ui.resourceUri`, KOBE-433) and its review state. */
export interface ToolApp {
  readonly resourceUri: string;
  readonly review: ToolAppReview;
}

export interface TeamConnectorTool {
  /** The name Pi sees; what a custom tick list stores. */
  readonly piName: string;
  readonly name: string;
  readonly title: string | null;
  readonly readOnly: boolean;
  /** MCP default is open-world, so an unannotated tool is write + open-world. */
  readonly openWorld: boolean;
  /** `drifted` tools are never offered until a site admin re-approves them (KOBE-102). */
  readonly status: "pinned" | "drifted";
  /** The MCP Apps template it opens and its review (KOBE-640); null when none (or older server). */
  readonly app?: ToolApp | null;
}

export interface TeamConnector {
  readonly id: string;
  readonly name: string;
  readonly authKind: "oauth" | "api_key" | "none";
  /** `site`: the organization provides the key (KOBE-303); members add none. */
  readonly credentialSource: "member" | "site";
  /** `site` only: the organization's key is set and still bound to the URL (KOBE-449). */
  readonly siteKeyReady: boolean;
  /** The site admin's switch; a disabled connector cannot be enabled by a team. */
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

/** The built-in Kobe connector's levels for a team (KOBE-623, spec kobe-admin-mcp §6, KA5). */
export type KobeLevel = "docs" | "read" | "read_write";
/** The site switch: `off` (no Kobe connector), `docs` (default), `admin`. */
export type KobeMode = "off" | "docs" | "admin";

export const KOBE_LEVEL_LABELS: Readonly<Record<KobeLevel, string>> = {
  docs: "Docs only",
  read: "Read",
  read_write: "Read and write",
};

export interface KobeTeamConnector {
  readonly connectorId: string | null;
  /** `kobe`, or `kobe-builtin` when a registered connector took the name; null if never seeded. */
  readonly name: string | null;
  readonly mode: KobeMode;
  readonly level: KobeLevel;
  /** Pi names of the docs tools (on in every conversation while the site switch is not off). */
  readonly docsTools: readonly string[];
  readonly adminTools: readonly {
    readonly piName: string;
    readonly title: string;
    readonly scope: "team" | "site";
    readonly readOnly: boolean;
  }[];
}

/** `GET /v1/team/connectors/kobe` (team.read). */
export async function getTeamKobe(teamId: string): Promise<ApiResult<KobeTeamConnector>> {
  const res = await apiRequest<{ kobe: KobeTeamConnector }>(`${BASE}/kobe`, { teamId });
  return res.ok ? { ...res, data: res.data.kobe } : res;
}

/** `PUT /v1/team/connectors/kobe` (team.connectors.manage), with the level the admin saw. */
export async function setTeamKobeLevel(
  teamId: string,
  level: KobeLevel,
  expected: KobeLevel,
): Promise<ApiResult<KobeTeamConnector>> {
  const res = await apiRequest<{ kobe: KobeTeamConnector }>(`${BASE}/kobe`, {
    method: "PUT",
    json: { level, expected_level: expected },
    teamId,
  });
  return res.ok ? { ...res, data: res.data.kobe } : res;
}

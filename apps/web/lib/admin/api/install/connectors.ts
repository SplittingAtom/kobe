/** Install console: connector registry (`/v1/install/connectors`, install.connectors.manage; KOBE-100). */
import { apiRequest, type ApiResult } from "../../../api/client";

const BASE = "/v1/install/connectors";

export type ConnectorAuthKind = "none" | "api_key" | "oauth";
export type ConnectorStatus = "active" | "disabled";

export interface Connector {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly iconUrl: string | null;
  readonly authKind: ConnectorAuthKind;
  readonly status: ConnectorStatus;
  readonly toolCount: number;
  /** Tools disabled pending re-approval (KOBE-102). */
  readonly driftedCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConnectorInput {
  readonly name: string;
  readonly url: string;
  readonly iconUrl: string | null;
  readonly authKind: ConnectorAuthKind;
}

export interface Removal {
  readonly soft: boolean;
  readonly teams: number;
  readonly message: string;
}

/** Same grammar as the server: lowercase letters and digits joined by one - or _. */
export const NAME_PATTERN = /^[a-z0-9]+([-_][a-z0-9]+)*$/;
export const AUTH_LABELS: Readonly<Record<ConnectorAuthKind, string>> = {
  none: "No authentication",
  api_key: "API key",
  oauth: "OAuth",
};

export async function listConnectors(): Promise<ApiResult<readonly Connector[]>> {
  const res = await apiRequest<{ connectors: readonly Connector[] }>(BASE);
  return res.ok ? { ...res, data: res.data.connectors } : res;
}

async function one(
  res: Promise<ApiResult<{ connector: Connector }>>,
): Promise<ApiResult<Connector>> {
  const r = await res;
  return r.ok ? { ...r, data: r.data.connector } : r;
}

export const createConnector = (input: ConnectorInput) =>
  one(apiRequest(BASE, { method: "POST", json: input }));

export const updateConnector = (
  id: string,
  patch: Partial<ConnectorInput> & { status?: ConnectorStatus },
) => one(apiRequest(`${BASE}/${encodeURIComponent(id)}`, { method: "PATCH", json: patch }));

export const removeConnector = (id: string): Promise<ApiResult<Removal>> =>
  apiRequest(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" });

export interface ToolDefinition {
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** One tool of a connector; a drifted one carries the live definition awaiting approval. */
export interface ToolReview {
  readonly name: string;
  readonly status: "pinned" | "drifted";
  readonly change: "changed" | "added" | null;
  readonly approved?: ToolDefinition;
  readonly live?: ToolDefinition & { readonly sha256: string };
}

export async function listConnectorTools(id: string): Promise<ApiResult<readonly ToolReview[]>> {
  const res = await apiRequest<{ tools: readonly ToolReview[] }>(
    `${BASE}/${encodeURIComponent(id)}/tools`,
  );
  return res.ok ? { ...res, data: res.data.tools } : res;
}

/** Approve the reviewed live definitions; each tool names the hash that was shown. */
export const approveConnectorTools = (
  id: string,
  tools: readonly { readonly name: string; readonly sha256: string }[],
): Promise<ApiResult<{ approved: readonly string[] }>> =>
  apiRequest(`${BASE}/${encodeURIComponent(id)}/tools/approve`, {
    method: "POST",
    json: { tools },
  });

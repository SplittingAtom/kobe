/** Site console: connector registry (`/v1/site/connectors`, site.connectors.manage; KOBE-100). */
import { apiRequest, type ApiResult } from "../../../api/client";

const BASE = "/v1/site/connectors";

export type ConnectorAuthKind = "none" | "api_key" | "oauth";
export type ConnectorStatus = "active" | "disabled";
/** KOBE-303: each member's own key, or one site-wide key for everyone (api_key connectors only). */
export type CredentialSource = "member" | "site";

export interface Connector {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly iconUrl: string | null;
  readonly authKind: ConnectorAuthKind;
  readonly credentialSource: CredentialSource;
  /** The site key's masked hint (last four characters at most); null when none is set. */
  readonly siteKeyHint: string | null;
  /** The server URL changed since the key was set: it is not used until re-entered. */
  readonly siteKeyStale: boolean;
  readonly status: ConnectorStatus;
  readonly toolCount: number;
  /** Tools disabled pending re-approval (KOBE-102). */
  readonly driftedCount: number;
  /** MCP Apps templates awaiting review (KOBE-434). */
  readonly templatesDriftedCount?: number;
  /** Why the last periodic refresh was skipped (`auth_required`, `unreachable`, ...; KOBE-431). */
  readonly refreshSkipped: string | null;
  readonly refreshedAt: string | null;
  /** Why the last refresh did not check the connector's app templates (KOBE-433). */
  readonly templatesSkipped?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConnectorInput {
  readonly name: string;
  readonly url: string;
  readonly iconUrl: string | null;
  readonly authKind: ConnectorAuthKind;
  readonly credentialSource: CredentialSource;
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

export const CREDENTIAL_LABELS: Readonly<Record<CredentialSource, string>> = {
  member: "Each member's own key",
  site: "Site-wide key",
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

/** What a Re-probe found (KOBE-430); `message` is the server's sentence for people. */
export type ReprobeOutcome =
  | { readonly status: "unchanged"; readonly message: string }
  | {
      readonly status: "drifted";
      readonly changed: number;
      readonly added: number;
      readonly removed: number;
      readonly message: string;
    }
  | { readonly status: "pinned"; readonly tools: number; readonly message: string };

export interface Reprobe {
  readonly connector: Connector;
  readonly refresh: ReprobeOutcome;
}

/** Probes the server now and applies drift (changed and new tools wait for approval). */
export const reprobeConnector = (id: string): Promise<ApiResult<Reprobe>> =>
  apiRequest(`${BASE}/${encodeURIComponent(id)}/refresh`, { method: "POST" });

export interface ToolDefinition {
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Risk hints (KOBE-434 review M4). */
  readonly annotations?: Record<string, unknown>;
  /** MCP Apps: the template it opens and who may see it (KOBE-433/435). */
  readonly ui?: { readonly resourceUri?: string; readonly visibility?: readonly string[] };
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

/** One version of an MCP Apps template (KOBE-434): never its bytes. */
export interface TemplateVersion {
  readonly sha256: string;
  readonly pinnedHash: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly meta: Record<string, unknown>;
}

export interface TemplateReview {
  readonly uri: string;
  readonly status: "pinned" | "drifted";
  readonly change: "changed" | "added" | "invalid" | null;
  readonly approved?: TemplateVersion;
  readonly live?: TemplateVersion;
  readonly invalid?: string;
}

/** One version's bytes with the hashes and meta of the same read (KOBE-434 review M1). */
export interface TemplateSourceVersion extends TemplateVersion {
  readonly html: string;
}

/** A template's bytes as text, for the escaped diff; approve with `live.pinnedHash`. */
export interface TemplateSource {
  readonly uri: string;
  readonly approved?: TemplateSourceVersion;
  readonly live?: TemplateSourceVersion;
}

/**
 * The admin preview frame of one version (review M2): served by Kobe as text/html with a
 * sandboxing header CSP (opaque origin, no network), like D25 artifacts; never `srcdoc`.
 */
export const templateFrameUrl = (
  id: string,
  uri: string,
  version: "live" | "approved",
  /** The bytes the admin's source read showed; the route answers 409 if they changed. */
  sha256: string,
) =>
  `${BASE}/${encodeURIComponent(id)}/templates/frame?uri=${encodeURIComponent(uri)}&version=${version}&sha256=${sha256}`;

export async function listConnectorTemplates(
  id: string,
): Promise<ApiResult<readonly TemplateReview[]>> {
  const res = await apiRequest<{ templates: readonly TemplateReview[] }>(
    `${BASE}/${encodeURIComponent(id)}/templates`,
  );
  return res.ok ? { ...res, data: res.data.templates } : res;
}

export async function getTemplateSource(
  id: string,
  uri: string,
): Promise<ApiResult<TemplateSource>> {
  const res = await apiRequest<{ source: TemplateSource }>(
    `${BASE}/${encodeURIComponent(id)}/templates/source?uri=${encodeURIComponent(uri)}`,
  );
  return res.ok ? { ...res, data: res.data.source } : res;
}

/** Approve the reviewed live templates; each names the pinned hash that was shown. */
export const approveConnectorTemplates = (
  id: string,
  templates: readonly { readonly uri: string; readonly pinnedHash: string }[],
): Promise<ApiResult<{ approved: readonly string[] }>> =>
  apiRequest(`${BASE}/${encodeURIComponent(id)}/templates/approve`, {
    method: "POST",
    json: { templates },
  });

/** Sets or replaces the site-wide key (KOBE-303); the key never comes back, only a hint. */
export const setSiteKey = (id: string, apiKey: string) =>
  one(
    apiRequest(`${BASE}/${encodeURIComponent(id)}/site-key`, {
      method: "PUT",
      json: { api_key: apiKey },
    }),
  );

export const removeSiteKey = (id: string): Promise<ApiResult<unknown>> =>
  apiRequest(`${BASE}/${encodeURIComponent(id)}/site-key`, { method: "DELETE" });

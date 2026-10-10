import { z } from "zod";
import { OauthError, oauthRequest, type OauthIo } from "./http.js";

/**
 * Finds the authorization server for an MCP server (MCP authorization spec 2026-07-28): the
 * server's Protected Resource Metadata (RFC 9728) names it, the server's metadata (RFC 8414 or
 * OpenID discovery) describes it. Refuses what the spec requires us to refuse: a resource that is
 * not the connector, an issuer that differs from where the metadata was fetched, and a server
 * without PKCE S256.
 */
export interface AuthServerInfo {
  /** The canonical MCP server URL (RFC 8707 `resource`). */
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string | undefined;
  /** The server accepts a Client ID Metadata Document URL as `client_id`. */
  readonly cimd: boolean;
  /** `iss` must come back on the authorization response (RFC 9207). */
  readonly issParameterSupported: boolean;
  readonly tokenAuthMethods: readonly string[];
}

const prmSchema = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).min(1),
  scopes_supported: z.array(z.string()).optional(),
});

const metadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
  client_id_metadata_document_supported: z.boolean().optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});

/** Same URL, ignoring a trailing slash on the path. */
export const sameUrl = (a: string, b: string): boolean => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/$/, "") === y.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
};

/** RFC 8615 well-known URL for a resource or issuer URL: the suffix goes between host and path. */
export function wellKnown(base: string, suffix: string): string {
  const url = new URL(base);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/${suffix}${path}`;
}

async function firstJson(io: OauthIo, urls: string[]): Promise<unknown> {
  for (const url of urls) {
    const res = await oauthRequest(io, url, {}, "oauth_unreachable");
    if (res.status === 200 && res.json !== undefined) return res.json;
  }
  throw new OauthError("oauth_unsupported");
}

/**
 * The `resource_metadata` URL an unauthenticated request to the MCP server is answered with
 * (RFC 9728 §5.1), if it is on the server's own origin; undefined otherwise.
 */
async function metadataHint(io: OauthIo, mcpUrl: string): Promise<string | undefined> {
  try {
    const res = await oauthRequest(
      io,
      mcpUrl,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      "oauth_unreachable",
    );
    const match = /resource_metadata="([^"]{1,2048})"/i.exec(res.wwwAuthenticate ?? "");
    if (res.status !== 401 || !match?.[1]) return undefined;
    return new URL(match[1]).origin === new URL(mcpUrl).origin ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

export async function discoverAuthServer(io: OauthIo, mcpUrl: string): Promise<AuthServerInfo> {
  const hint = await metadataHint(io, mcpUrl);
  const prm = prmSchema.safeParse(
    await firstJson(io, [
      ...(hint ? [hint] : []),
      wellKnown(mcpUrl, "oauth-protected-resource"),
      `${new URL(mcpUrl).origin}/.well-known/oauth-protected-resource`,
    ]),
  );
  if (!prm.success || !sameUrl(prm.data.resource, mcpUrl))
    throw new OauthError("oauth_unsupported");
  const issuer = prm.data.authorization_servers[0] ?? "";
  const meta = metadataSchema.safeParse(
    await firstJson(io, [
      wellKnown(issuer, "oauth-authorization-server"),
      wellKnown(issuer, "openid-configuration"),
      `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
    ]),
  );
  if (!meta.success) throw new OauthError("oauth_unsupported");
  const m = meta.data;
  if (m.issuer !== issuer) throw new OauthError("oauth_unsupported");
  if (!(m.code_challenge_methods_supported ?? []).includes("S256")) {
    throw new OauthError("oauth_unsupported");
  }
  return {
    resource: prm.data.resource,
    scopes: prm.data.scopes_supported ?? [],
    issuer: m.issuer,
    authorizationEndpoint: m.authorization_endpoint,
    tokenEndpoint: m.token_endpoint,
    registrationEndpoint: m.registration_endpoint,
    cimd: m.client_id_metadata_document_supported === true,
    issParameterSupported: m.authorization_response_iss_parameter_supported === true,
    tokenAuthMethods: m.token_endpoint_auth_methods_supported ?? ["client_secret_basic"],
  };
}

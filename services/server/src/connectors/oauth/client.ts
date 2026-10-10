import { z } from "zod";
import type { AuthServerInfo } from "./discovery.js";
import { OauthError, oauthRequest, type OauthIo } from "./http.js";
import { challengeOf } from "./pkce.js";

/** The OAuth client Kobe presents to an authorization server for one connect flow. */
export interface ClientRegistration {
  readonly clientId: string;
  /** Only for a dynamically registered confidential client; sealed with the tokens. */
  readonly clientSecret: string | undefined;
}

/** Where Kobe publishes its Client ID Metadata Document, and its callback, on its own origin. */
export const CLIENT_METADATA_PATH = "/v1/oauth/client-metadata.json";
export const CALLBACK_PATH = "/v1/connector-grants/oauth/callback";

export interface KobeOrigin {
  readonly origin: string;
  readonly clientMetadataUrl: string;
  readonly redirectUri: string;
}

export function kobeOrigin(publicUrl: string): KobeOrigin {
  const origin = new URL(publicUrl).origin;
  return {
    origin,
    clientMetadataUrl: `${origin}${CLIENT_METADATA_PATH}`,
    redirectUri: `${origin}${CALLBACK_PATH}`,
  };
}

/** The Client ID Metadata Document (served publicly): a public client using PKCE. */
export function clientMetadataDocument(kobe: KobeOrigin) {
  return {
    client_id: kobe.clientMetadataUrl,
    client_name: "Kobe",
    client_uri: kobe.origin,
    redirect_uris: [kobe.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

const registrationSchema = z.object({
  client_id: z.string().min(1).max(512),
  client_secret: z.string().min(1).max(1024).optional(),
});

/**
 * CIMD when the server supports it and Kobe is served over https (the metadata document must be
 * fetchable by the server); otherwise Dynamic Client Registration (RFC 7591), asking for a
 * confidential client when the server offers a secret-based method.
 */
export async function obtainClient(
  io: OauthIo,
  info: AuthServerInfo,
  kobe: KobeOrigin,
): Promise<ClientRegistration> {
  if (info.cimd && kobe.origin.startsWith("https://")) {
    return { clientId: kobe.clientMetadataUrl, clientSecret: undefined };
  }
  if (!info.registrationEndpoint) throw new OauthError("oauth_unsupported");
  const confidential = info.tokenAuthMethods.includes("client_secret_basic");
  const res = await oauthRequest(
    io,
    info.registrationEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Kobe",
        client_uri: kobe.origin,
        redirect_uris: [kobe.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: confidential ? "client_secret_basic" : "none",
      }),
    },
    "registration_failed",
  );
  const parsed = registrationSchema.safeParse(res.json);
  if (res.status < 200 || res.status > 201 || !parsed.success) {
    throw new OauthError("registration_failed");
  }
  return { clientId: parsed.data.client_id, clientSecret: parsed.data.client_secret };
}

export function authorizationUrl(input: {
  readonly info: AuthServerInfo;
  readonly client: ClientRegistration;
  readonly redirectUri: string;
  readonly state: string;
  readonly verifier: string;
  /** Dev only (`allowHttp` of the connector policy): accept an http authorization endpoint. */
  readonly allowHttp: boolean;
}): string {
  let url: URL;
  try {
    url = new URL(input.info.authorizationEndpoint);
  } catch {
    throw new OauthError("oauth_unsupported");
  }
  const schemeOk = url.protocol === "https:" || (input.allowHttp && url.protocol === "http:");
  if (!schemeOk || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new OauthError("oauth_unsupported");
  }
  const set = (k: string, v: string) => url.searchParams.set(k, v);
  set("response_type", "code");
  set("client_id", input.client.clientId);
  set("redirect_uri", input.redirectUri);
  set("state", input.state);
  set("code_challenge", challengeOf(input.verifier));
  set("code_challenge_method", "S256");
  set("resource", input.info.resource);
  if (input.info.scopes.length > 0) set("scope", input.info.scopes.join(" "));
  return url.toString();
}

export const tokenSchema = z.object({
  access_token: z.string().min(1).max(8192),
  token_type: z.string().refine((t) => t.toLowerCase() === "bearer"),
  expires_in: z
    .number()
    .positive()
    .max(10 * 365 * 24 * 3600)
    .optional(),
  refresh_token: z.string().min(1).max(8192).optional(),
  scope: z.string().max(2048).optional(),
});

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly scope: string | undefined;
  readonly expiresAt: Date | undefined;
}

/** Content type plus client authentication: Basic for a confidential client, else `client_id` in the form. */
export function tokenRequestHeaders(
  form: URLSearchParams,
  client: ClientRegistration,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (client.clientSecret === undefined) {
    form.set("client_id", client.clientId);
  } else {
    const pair = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`;
    headers.authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
  }
  return headers;
}

/** Exchanges the authorization code server-side, with the PKCE verifier and the resource. */
export async function exchangeCode(
  io: OauthIo,
  input: {
    readonly tokenEndpoint: string;
    readonly resource: string;
    readonly client: ClientRegistration;
    readonly redirectUri: string;
    readonly code: string;
    readonly verifier: string;
    readonly now: Date;
  },
): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
    resource: input.resource,
  });
  const headers = tokenRequestHeaders(form, input.client);
  const res = await oauthRequest(
    io,
    input.tokenEndpoint,
    { method: "POST", headers, body: form.toString() },
    "token_exchange_failed",
  );
  const parsed = tokenSchema.safeParse(res.json);
  if (res.status !== 200 || !parsed.success) throw new OauthError("token_exchange_failed");
  const t = parsed.data;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    scope: t.scope,
    expiresAt:
      t.expires_in === undefined ? undefined : new Date(input.now.getTime() + t.expires_in * 1000),
  };
}

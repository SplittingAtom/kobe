/**
 * Upstream credentials (D27: "the proxy attaches the user's real credential"). KOBE-61 owns
 * per-user OAuth (MCP 2026-07-28) and API-key grants and implements this seam; the credential is
 * attached here, in the proxy, and never reaches the sandbox. `NO_GRANTS` (tests, or no server)
 * allows only `auth_kind: none`; {@link createServerCredentials} adds API-key grants (KOBE-108).
 */
export interface CredentialRequest {
  /** The sandbox's session token: the server derives the user from it and serves that user's grant. */
  readonly token: string;
  readonly teamId: string;
  readonly userId: string;
  readonly connector: {
    readonly id: string;
    readonly url: string;
    readonly auth_kind: "oauth" | "api_key" | "none";
  };
}

export type CredentialResult =
  | { readonly ok: true; readonly headers: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly code: "not_connected" | "unavailable" };

export interface CredentialResolver {
  headersFor(request: CredentialRequest): Promise<CredentialResult>;
}

export const NO_GRANTS: CredentialResolver = {
  headersFor: ({ connector }) =>
    Promise.resolve(
      connector.auth_kind === "none"
        ? { ok: true, headers: {} }
        : { ok: false, code: "not_connected" },
    ),
};

/** How an API key reaches the upstream: a bearer token. Built here, in the proxy, only. */
export function apiKeyHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

/** How an OAuth access token reaches the upstream (MCP authorization spec): a bearer token. */
export const oauthHeaders = apiKeyHeaders;

/** What the server's grant endpoint can say (KOBE-108). */
export type GrantAnswer =
  | {
      readonly ok: true;
      readonly value:
        | { readonly kind: "api_key"; readonly apiKey: string }
        | { readonly kind: "oauth"; readonly accessToken: string };
    }
  | { readonly ok: false; readonly failure: "not_connected" | "unavailable" };

export interface GrantSource {
  fetchGrant(token: string, connectorId: string): Promise<GrantAnswer>;
}

/**
 * Per-user grants from the server's internal API (KOBE-108, KOBE-109). `none` connectors need
 * nothing; `api_key` and `oauth` connectors get the run's user's key or access token as a bearer
 * token, fetched per call and held only for that request (never cached, logged or returned to the
 * sandbox). A grant of the other kind than the connector's is "not connected". Refreshing an
 * expired access token is the server's job (KOBE-110).
 */
export function createServerCredentials(source: GrantSource): CredentialResolver {
  return {
    async headersFor({ token, connector }) {
      if (connector.auth_kind === "none") return { ok: true, headers: {} };
      const grant = await source.fetchGrant(token, connector.id);
      if (!grant.ok) return { ok: false, code: grant.failure };
      const value = grant.value;
      if (value.kind !== connector.auth_kind) return { ok: false, code: "not_connected" };
      return {
        ok: true,
        headers:
          value.kind === "oauth" ? oauthHeaders(value.accessToken) : apiKeyHeaders(value.apiKey),
      };
    },
  };
}

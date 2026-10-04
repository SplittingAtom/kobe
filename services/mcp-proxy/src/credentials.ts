/**
 * Upstream credentials (D27: "the proxy attaches the user's real credential"). KOBE-61 owns
 * per-user OAuth (MCP 2026-07-28) and API-key grants and implements this seam; the credential is
 * attached here, in the proxy, and never reaches the sandbox. Until then only connectors with
 * `auth_kind: none` can be called; the others answer "not connected".
 */
export interface CredentialRequest {
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

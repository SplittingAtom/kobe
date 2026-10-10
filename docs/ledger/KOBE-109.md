# KOBE-109: OAuth grants per MCP 2026-07-28 (61c)

- **Status:** in review (migration PR #180, feature PR follows it)
- **Branch / worktree:** `kobe-109-oauth-grants` in `../Kobe-wt109` (migration: `kobe-109-oauth-grants-migration`)
- **Depends on:** KOBE-107 (envelope), KOBE-108 (`connector_grants`, internal grant endpoint, proxy delivery)

## Plan

Migration PR first (`kind` allows `oauth`, nullable `expires_at`), then the flow, routes and proxy delivery.

## Decisions

- **Migration:** `0080_connector_grants_oauth` only widens the `kind` CHECK and adds `expires_at`
  (access-token expiry, not secret; KOBE-110 uses it). No new table: no pending-flow rows.
- **Flow state is sealed, not stored.** `state = <team>.<connector>.<envelope>` (KOBE-107, kind
  `oauth_state`, bound to team + user + connector). Payload: PKCE verifier, issuer, token endpoint,
  client id/secret, resource, 10 min expiry. It opens only for the user it was minted for, in the
  team and for the connector it names; the callback also requires the session's active team to match.
  The authorization code is single-use at the server, so a replayed callback fails there.
- **Discovery** (`connectors/oauth/discovery.ts`): PRM (RFC 9728, path-specific then root) must name
  the connector URL as `resource`; first authorization server's metadata (RFC 8414, then OIDC) must
  carry the same `issuer` and `S256`. Anything else is `oauth_unsupported`. Every outbound URL passes
  the connector address policy (`checkConnectorUrl`), no redirects, 10 s, 256 KB.
- **Client:** CIMD (`client_id` = `<origin>/v1/oauth/client-metadata.json`, public route) when the
  server supports it and Kobe is on https; else DCR (RFC 7591), confidential
  (`client_secret_basic`) when offered. No registration possible: `oauth_unsupported`.
- **Request:** PKCE S256, RFC 8707 `resource` on authorization and token requests, scopes from PRM.
  Callback: RFC 9207 `iss` must equal the issuer; a missing `iss` is refused when the server says it
  sends one. Redirect URI is on Kobe's origin: `/v1/connector-grants/oauth/callback`.
- **Storage:** the token bundle (`connectors/oauth/bundle.ts`: access + refresh token, client,
  token endpoint, issuer, resource) is sealed in `connector_grants.sealed` with the same envelope
  context as API keys; `hint` is a constant. Summaries add `kind` and `expires_at` only.
- **Delivery:** the internal grant endpoint answers `{kind: "oauth", access_token}`; mcp-proxy
  attaches it as a bearer token like an API key, and treats a grant of the wrong kind as not
  connected. An expired access token is `unavailable` (503) until KOBE-110 refreshes.
- Out of scope (KOBE-110): refresh, revoke at the authorization server, suspension. No connect UI
  here (KOBE-105): the callback redirects to `/?connector_oauth=connected|failed&connector=<id>`.

## Open questions

1. The server fetches discovery URLs after a DNS check; a rebinding race between check and connect
   is not closed there (the proxy closes it per connection for upstream calls). Same trade-off as the
   registry probe URL check.
2. A connector that returns 401 with `WWW-Authenticate: resource_metadata=` is not consulted; only
   the well-known locations are tried.

## Evidence

| Criterion                         | Evidence                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| ac-1 connect against a reference  | `services/server/src/connector-oauth.db.test.ts` (fake authorization server, full flow)             |
| ac-2 tokens stored only encrypted | same file: sealed column, no token in responses, audit rows or logs; DB CHECK `^e1\.`               |
| State, PKCE, iss, other user      | same file "refusals"; `connectors/oauth/oauth.test.ts`; proxy: `credentials.test.ts`, `mcp.test.ts` |

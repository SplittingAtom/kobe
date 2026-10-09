# KOBE-108: API-key grants per user (61b)

- **Status:** in review (migration PR #147, feature PR follows it)
- **Branch / worktree:** `kobe-108-api-key-grants` in `../Kobe-wt108` (migration: `kobe-108-api-key-grants-migration`)
- **Depends on:** KOBE-101 (pinning), KOBE-107 (envelope), KOBE-58 (proxy); KOBE-104 enables connectors per team

## Plan

Migration PR first (table, RLS, fixtures), then the service, routes, internal grant endpoint and proxy delivery.

## Decisions

- **Migration needed.** `connector_grants` was only a stale install-wide name in `tenancy/connectors.ts`
  (no table); it is now a team table. PK `(team_id, user_id, connector_id)`; `sealed` = KOBE-107 envelope
  text (CHECK `^e1\.`, so plaintext is refused by the database), `key_id` for rotation sweeps, `hint`.
- **RLS `team_isolation` only.** No `break_glass_read`: a credential is not content an admin may read.
  Legal hold not applicable: not retained team content, and users must be able to remove a key under a hold.
- **Sealed per (team, user, connector):** envelope AAD = team id, kind `connector_grant`, record id
  `<user>:<connector>`; a ciphertext moved to another user's row does not open (tested).
- **Never returned.** `GET/PUT/DELETE /v1/connector-grants[/:connectorId]` return `connector_id`, masked
  `hint` (last 4 only for keys >= 16 chars) and timestamps; `Cache-Control: no-store`. The key is accepted
  on PUT only (8-2048 visible ASCII, header-safe). PUT works only for an active, team-enabled `api_key` connector.
- **Delivery.** mcp-proxy calls `POST /internal/v1/mcp/connectors/:id/grant` (internal key + the sandbox's
  own token). The server derives (team, user) from the verified token, so only the run's own user's key can
  be returned; the proxy puts it in `Authorization: Bearer` on the upstream request, per call, uncached,
  unlogged. The sandbox listener has no such route; the sandbox only ever sees tool results.
- **Pinning with a user's key.** After a PUT the server probes with the key (`api_key` field of the proxy's
  internal probe) only while the connector has no pins (KOBE-101's conditional write); a failed probe never
  fails the save. Audited as `mcp.connector.pinned`.
- **Audit:** `mcp.grant.added|replaced|removed` (team scope; connector id and name only).
- Out of scope (KOBE-110): refresh, revoke on offboarding, suspension. OAuth grants (KOBE-61).

## Open questions (for Chris or the coordinator)

1. Placement: KOBE-100's ledger says API keys go in query parameters; I used a bearer header (query strings
   leak into logs and are refused in connector URLs). A per-connector placement (header name or query
   parameter) would need a registry column: separate ticket?
2. A user's key can pin an unpinned connector's tools (as asked). An install admin can still re-approve
   via KOBE-102 drift; say if pinning should stay admin-only.
3. No connect UI in this PR (API only).

## Evidence

| Criterion                            | Evidence                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1 connect with a key and use it   | `services/server/src/connector-grants.db.test.ts` (PUT, internal grant); `services/mcp-proxy/src/mcp.test.ts` (key on the upstream request)          |
| ac-2 key absent from the sandbox     | `mcp.test.ts` (nothing sandbox-bound carries it), `connector-grants.db.test.ts` "nothing else carries the key", API responses and audit rows scanned |
| Other user's / team's key never used | `connector-grants.db.test.ts` "whose key is used"; RLS: `packages/db/src/connector-grants.db.test.ts`                                                |

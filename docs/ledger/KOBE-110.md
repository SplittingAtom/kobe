# KOBE-110: Grant refresh, revoke and suspension (61d)

- **Status:** in review
- **Branch / worktree:** `kobe-110-grant-refresh-revoke` in `../Kobe-wt110`
- **Depends on:** KOBE-108, KOBE-109 (merged)

## Plan

Refresh inside `revealCredential` (the one place a grant is decrypted), liveness re-checked at the
same place, audit for failures. No migration, no proxy change.

## Decisions

- **Refresh trigger:** at reveal, when `expires_at - 60 s <= now`. `connectors/oauth/refresh.ts`
  sends `grant_type=refresh_token` + RFC 8707 `resource` to the token endpoint sealed in the grant,
  through the KOBE-109 `oauthRequest` (pinned address, no redirects, 10 s, 256 KB). The mcp service
  gets the client via `oauthIo` (same connector URL policy as the connect flow).
- **Serialization across replicas:** `refreshAndReveal` opens a `withTeam` tx and takes the grant
  row `SELECT ... FOR UPDATE`, re-reads it, and only then calls the token endpoint (lock held,
  <= 10 s). A second caller blocks, then sees a fresh `expires_at` and serves what the first
  stored, so a rotating refresh token is spent once. The rotated token is sealed back in the same
  tx. Plain reads (no refresh needed) take no lock.
- **Failure:** `invalid_grant` / `invalid_client` / `unauthorized_client`, or an expired token with
  no refresh token: grant row deleted, audit `mcp.grant.refresh_failed` (`rejected` |
  `no_refresh_token`), reveal answers `not_connected` (404): the user reconnects. Anything
  transient (down, 5xx, garbage): grant kept, logged by code only, `unavailable` (503) if the
  token is truly expired, otherwise the still-valid token is served.
- **Revoke (ac-1):** DELETE removes the row; the proxy never caches credentials (verified: fetched
  per call, `Cache-Control: no-store`; no Map/TTL in `services/mcp-proxy`), so the next call gets 404. A revoke during a refresh queues behind the row lock and wins; no token is stored after it.
- **Deactivation / removal (ac-2):** `loadGrant` runs on every reveal and requires: connector
  enabled for the team and `active`, `users.deactivated_at IS NULL`, a `team_members` row. Else
  `not_available` (and `mcp.grant.refused` reason `user_inactive` for the user case). No sweep, no
  refresh attempt for such users. The internal API's sandbox liveness check refuses earlier (401).
- **Team suspension:** teams have no suspended state in the schema; membership removal and
  connector `disabled` are what exist, and both stop grants. Revisit if a team status is added.
- Audit rows carry connector id, name and a reason code only; tests assert no token in audit/logs.

## Open questions (for Chris or the coordinator)

- RFC 7009 revocation at the provider is not sent: the bundle stores no `revocation_endpoint`
  (KOBE-109 discovery does not read it). Cheap follow-up: store it at connect, POST on DELETE.
- Refresh holds a DB connection for up to 10 s per grant while the token endpoint answers.

## Evidence (acceptance criteria -> test)

| Criterion                      | Evidence                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------- |
| ac-1 revoke immediate          | `connector-refresh.db.test.ts` "a revoke stops the next reveal", "...waits"   |
| ac-2 deactivated users stop    | same file: "a deactivated user's grant stops working", "removed from team"    |
| Refresh, rotation, concurrency | same file: "uses the refresh token", "serializes concurrent callers" (1 call) |
| invalid_grant needs reconnect  | same file: "treats invalid_grant as needs-reconnect" (+ audit, no secrets)    |
| SSRF on token endpoint         | `connectors/oauth/refresh.test.ts`                                            |

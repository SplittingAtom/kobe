# KOBE-454: Removing a connector keeps its sealed site key and members' grants

- **Status:** in review (not pushed; coordinator opens the PR)
- **Branch / worktree:** `group-33-connector-removal` in `../Kobe-wt454`
- **Depends on:** KOBE-303/431 (site key), KOBE-108/109 (grants)

## Plan

Removal stays a soft delete (audit history, `team_connectors` rows, foreign keys), but its secrets
go with it: `removeConnector` (`services/server/src/connectors/registry.ts`) now calls the existing
`dropSiteKey(tx, …, "connector_removed")` and `dropConnectorGrants(tx, …)` in the removal's
transaction, under the row lock. Already removed connectors are cleaned by a custom migration.

## Decisions

- **What is destroyed, when:** at removal, in the same transaction: the `connector_site_keys` row
  (sealed site key) and every `connector_grants` row for the connector in every team (API keys and
  OAuth bundles: access and refresh tokens, client registration). A failure rolls the removal back.
- **OAuth revocation:** Kobe has no token-revocation client (`oauth/` has discovery, flow,
  refresh only), so tokens are deleted, not revoked at the provider. Follow-up if wanted.
- **mcp-proxy:** caches no credential: it asks the server's grant endpoint per call
  (`credentials.ts`), and the reveal already refuses a removed connector. No hint/notify needed;
  a proxy test pins "refused on the next call".
- **Audit:** `mcp.connector.removed` gains `siteKeyDropped` (boolean; a field ending in "key" is refused by the taxonomy test) and `grants` (count), optional in
  the schema so older rows still validate; plus the existing `mcp.connector.site_key_removed`
  (reason `connector_removed`, new enum value) and one `mcp.grant.removed` per grant (team-scoped),
  as a URL change already does. No key, hint or token in any of them. `docs/audit-log.md` updated.
- **Re-add / restore (ac-3):** secrets are keyed by connector id; a re-registered connector is a new
  row (a removed name stays reserved, `name_removed`), and a hand-restored row has nothing left.
- **Legal hold / retention:** does not apply. Grants and site keys are credentials, not retained
  team content (as `0076_connector_grants_rls.sql` already states); no hold trigger guards them,
  and the audit trail (which holds do guard) is kept.
- **Backfill:** `packages/db/drizzle/0173_removed_connector_credentials.sql`, custom, its own
  commit (ac-2 asks for a migration). Deletes site keys and grants whose connector has
  `deleted_at`; FORCE RLS on `connector_grants` lifted for the delete only (as 0123/0159).
  Idempotent. Not audited row by row (a migration has no actor; the counts are visible in the
  database before the upgrade if needed).

- **Review fixes (Opus review):** (1) storing a grant now takes `FOR SHARE` on the connector row
  in its transaction and requires `status=active` and `deleted_at IS NULL`, so a key saved during
  a removal is refused, not left behind (race test). (2) `dropConnectorGrants` no longer calls
  `set_config` itself: it walks the teams with one `withTeam()` transaction each (removal, URL
  and mode change). The caller still holds the connector row `FOR UPDATE` (no new grants), and
  calls it before writing any audit row (the audit chain lock would block the team
  transactions). So "same transaction" (ac-1) becomes "under the removal's row lock, committed just
  before it": if the removal then fails, the grants stay deleted, the safe direction.

## Open questions (for Chris or the coordinator)

- Revoke OAuth tokens at the provider on removal (RFC 7009) as a follow-up ticket?

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/connector-site-key.db.test.ts` "removing the connector destroys its
  credentials (KOBE-454)": site key gone, grants in two teams gone, audit counts, no secret in
  audit/logs.
- ac-2: `packages/db/src/removed-connector-credentials-upgrade.db.test.ts` (removed connector's
  key + 2 grants deleted, live connector's kept, FORCE back on, re-run is a no-op).
- ac-3: same server test: hand-restored row serves no key (404), re-registered connector has none.
- mcp-proxy: `credentials.test.ts` "caches nothing".

## gate1 note

The migration removes catalyst (144a630f) and catalyst-1 (d68196aa) site keys and grants on the
next upgrade.

# KOBE-625: SSO-1 — SSO and SCIM migrations

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (commit on `kobe-625-sso-migration`, not pushed)
- **Branch / worktree:** `kobe-625-sso-migration` in `../Kobe-wt625` (from group branch `kobe-sso`)
- **Depends on:** spec `docs/specs/sso-oidc-scim.md` (SSO1–SSO10). Unblocks SSO-2 (KOBE-626) and
  SSO-6 (KOBE-627).

## Plan

Migrations alone (spec §17 SSO-1): schema, migration, registry, grants, backup exclusion, audit
schemas. No server code, no emitters.

## What landed

- `packages/db/drizzle/0209_sso.sql` (generated): `sso_providers`, `sso_identities`,
  `sso_access_mappings`, `session_sso_contexts`, `scim_tokens`, `scim_groups`,
  `scim_group_members`; `team_members_added_via` check now also allows
  `idp:<lowercase uuid>`.
- `packages/db/drizzle/0210_sso_guards.sql` (custom): `scim_tokens_guard` trigger (invoker rights,
  pinned `search_path`): hash, provider, prefix, creator and creation time never change; once
  `revoked_at` is set it stays (holds for the owner role too).
- Schema `packages/db/src/schema/sso.ts`; registry `packages/db/src/tenancy/identity.ts`.
- Backup: `session_sso_contexts` in `packages/cli/src/excluded.ts`, `docs/backup-restore.md`,
  `e2e/gate4-restore.sh`.
- Audit (`packages/db/src/audit/events.ts`, `docs/audit-log.md`): `SIGN_IN_METHODS` + `sso`; the
  21 `identity.sso.*` / `identity.scim.*` site events of spec §12; `identity.member.added|removed|
role_changed` take `via: "idp"` + `providerId`; new team event `identity.member.taken_over`.

## Decisions

- **All seven tables are site-wide** (identity domain, no RLS), like `connectors`, `site_settings`,
  `session_active_teams`. Only `sso_access_mappings` carries `team_id` (FK to `teams`, cascade):
  `teamReferencing` reason "site configuration naming teams, no team content".
- **Grants:** ALL on every new table except `scim_tokens`: `SELECT, INSERT` plus column-level
  `UPDATE (last_used_at, revoked_at)`; no DELETE (rows go only by cascade with their provider).
- **Foreign keys:** deleting a provider is refused (NO ACTION) while an `sso_identities` row or a
  `session_sso_contexts` row names it (spec §4 "delete only when no identity is linked", §9 "its
  sessions deleted" first); mappings, SCIM tokens and SCIM groups cascade with it. Identities
  reference `users` with NO ACTION (users are never deleted).
- **Client secret:** `client_secret_sealed` (KOBE-107 envelope text, same `^e1\.` check and
  16 KiB bound as `connector_site_keys.sealed`) plus `client_secret_key_id` for the rotation sweep,
  as connector site keys do. Check `sso_providers_secret_source`: console rows must have both, Helm
  rows must have neither (the Secret is never copied into the database, §4).
- **SCIM token:** `token_hash` = SHA-256 hex only (check `^[0-9a-f]{64}$`, unique), `prefix` for
  display.
- **Entra tenant:** `tenant_id uuid`, required when `kind = 'entra'` (a GUID type also rules out
  `common`/`organizations`/`consumers`). `issuer` must be `https://`.
- **`enabled` defaults to false** (a new provider is off until an admin turns it on); spec is silent.
- Added `max_session_hours` (spec §9 "optional per provider") so SSO-3/4 need no migration.
- `mfa_rule` jsonb defaults to the spec §8 `amr_any` list; the Entra preset (`acrs_any: ["c1"]`)
  is SSO-2's to write.
- No table is startup-seeded: `STARTUP_SEEDED_ROWS` and `restore-target.db.test.ts` unchanged.
  SSO-2's start-up upsert of Helm providers **will** seed `sso_providers`: KOBE-626 must add it to
  `STARTUP_SEEDED_ROWS` (or otherwise teach the restore-target check).

## Spec deviations

- **Audit names:** spec §12 says team-scope `team.member.added|role_changed|removed` with
  `via: "idp"`. The published actions are `identity.member.*` (never rename or duplicate a
  published action), so those take `via: "idp"` and `providerId` instead.
- **`scimTokenId` → `credentialId`:** the audit taxonomy test forbids field names containing
  `token` (secret-looking), so SCIM events carry `credentialId` (the `scim_tokens.id`).
- Added `identity.member.taken_over` (SSO10 "audited Take over"; not listed in §12).

## Open questions (for Chris or the coordinator)

- Admin-expected links (§6, "single use, expires in 14 days") need storage the spec names no table
  for; SSO-5 (KOBE-630) will need a small migration (e.g. `sso_link_expectations`) or a column.
- "At most two live SCIM tokens" (§10) is left to SSO-7's code (no DB constraint).

## Guide pages

None for this ticket: it adds tables and audit schemas only, nothing a person can see or do yet.
Spec §18's pages (getting-started, admin/site-admin, admin/team-admin,
reference/troubleshooting, glossary) are SSO-10's (KOBE-634); `docs/audit-log.md` and
`docs/backup-restore.md` (operator docs, not the guide) are updated here.

## Evidence (acceptance criteria → test or command output)

- ac-1 migration up: fresh database in every DB suite (`catalog.db.test.ts`, `probe.db.test.ts`);
  previous migration + representative rows (teams, users, memberships incl. a managed one, a
  session) → `packages/db/src/sso-upgrade.db.test.ts` (9 tests: empty tables, rows kept, checks,
  FKs, cascades, `idp:<uuid>`).
- ac-2 cross-team probe suite green (`probe.db.test.ts`; no new team table, so no new fixture).
- ac-3 grants match the registry: `catalog.db.test.ts` catalog check; `tenancy.test.ts` (KOBE-625
  case); `sso-upgrade.db.test.ts` (app role: DELETE and hash UPDATE on `scim_tokens` → 42501).
- ac-4 backup excludes `session_sso_contexts`: `packages/cli/src/backup-restore.db.test.ts`
  (manifest exclusion list; context marker absent from the decrypted dump while provider, sealed
  secret, identity and SCIM hash are present and only encrypted on disk); `excluded.test.ts`.
- Commands: build, typecheck, lint, format:check, `drizzle-kit check`, `db:check`,
  `pnpm test:db --filter='!@kobe/server'`, `@kobe/server test:db`, public hygiene, site wording —
  results in the coordinator report.

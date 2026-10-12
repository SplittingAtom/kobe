# KOBE-256: Rename R3: Site replaces Install in the database (tables, enums, columns, constraints)

- **Status:** in review: PR #248 (a: migration), PR #249 (b: code, stacked on #248)
- **Branch / worktree:** `kobe-256-site-rename-db` (a), `kobe-256-site-rename-code` (b) in `../Kobe-wt256`
- **Depends on:** R1 KOBE-257, R2 KOBE-255 (both merged).

## Plan

Two PRs. (a) the migration `0091_site_rename` with everything that must change with it: drizzle
schema names and snapshot, SQL in code, tests and docs, tenancy registry (grants matrix), the CLI's
seeded tables, and the code that writes the two migrated stored values; DB upgrade test and CLI
old-backup test. (b) code: drizzle object identifiers (`installAgents` → `siteAgents`, …), the
budget scope, policy stage/reason codes, rule scope and manifest floor values (`install` →
`site`, readers accept both), the Bifrost customer, the identifier guard; drops the mappings (a)
adds at the database boundary.

## Decisions

- **Rename in place:** `ALTER TYPE/TABLE/INDEX/TRIGGER/FUNCTION … RENAME` and `RENAME CONSTRAINT`
  only; no table rewrite. Renamed: 11 tables (`install_settings`, `install_roles`,
  `install_model_limits`, `install_model_spend_daily`, `install_budget_reservations`,
  `install_tool_rules`, `install_agents`, `install_agent_versions`, `install_skills`,
  `install_skill_versions`, `install_skill_scans`), types `install_role`, `install_agent_scope`,
  column `threads.install_agent_id`, 56 constraints (incl. implicit `*_pkey`), 6 indexes, 5
  triggers, functions `break_glass_is_install_admin`, `kobe_install_limits_guard`. No sequences or
  RLS policies were named after install; no enum value said install.
- **Function bodies:** plpgsql/SQL bodies name tables as text, so the 17 functions whose body said
  install are `CREATE OR REPLACE`d (generated from `pg_get_functiondef` with a fixed rename map,
  reviewed by diff): table names, the advisory lock keys (`kobe.site_admin_set`,
  `kobe.budget:site`; only these functions take them), `scope = 'site'`, error messages.
- **Stored values:** small site tables are updated in the migration: `budget_alerts.scope`
  `install` → `site`, `break_glass_notifications.recipient_role` `install_admin` → `site_admin`
  (checks swapped around the UPDATE). `runs.budget_stop_scope` is history on a large table: not
  rewritten; its check widens to `site, install, team, user` (`NOT VALID`: a widening, so no scan
  of `runs` under the lock). Audit rows: untouched (hash chain).
- **Boundary in (a):** budget lines stay `install` in code until (b); the monitor writes alerts
  as `site` and the gateway sends the site line to `kobe_reserve_budget` as `site`.
- **Drizzle snapshot:** the custom migration's snapshot is generated from the new schema (a
  from-scratch `drizzle-kit generate` with this chain's id/prevId), so `db:check` sees no drift.
  Checked by hand: tables, columns, constraints and indexes of the upgraded database equal those of
  a database built from that from-scratch SQL (only differences: custom objects and `NOT VALID`).
- **Upgrade window:** renames are not backward compatible: pods of the previous release fail on
  the renamed tables between the migration Job and their replacement (documented in
  `docs/install.md` upgrade notes). No compatibility views (they would be install-named objects
  the catalog checks and grants matrix would have to carry).
- **Old backups:** refused by a renamed site (journal differs, nothing loaded); restore on their
  own release with its CLI, then upgrade (`docs/backup-restore.md#limits`). The new CLI cannot
  restore into an old schema (its restore SQL names `site_settings`), consistent with the
  same-version rule.

- **0091 is hand-written** (first line `-- kobe:hand-written`): never regenerate it. If `main`
  gains a migration first, renumber by hand (move SQL and snapshot to the next index, fix journal
  `idx`/`when`, re-chain `prevId`). `db:rebase` now keeps a marked migration's SQL and snapshot and
  only renumbers it; it refuses when the base changed the schema since the fork, or when the
  branch also has generated migrations (`scripts/migration-plan.mjs`, unit-tested).
- **Review fixes (#248):** rollback note (H1: `helm rollback` cannot undo 0091; back up first),
  scheduler pods and CLI version (L2), `kobe_reserve_budget` takes an `install` line from an old
  gateway as the site's (L1, `budget-reservations.db.test.ts`).
- **(b) code:** drizzle objects `siteAgents`, `siteRoles`, `siteRole` (enum), … ; budget scope
  `site` end to end (lines, gateway, alerts, run stops, `run.budget_stopped`, API, web), the (a)
  boundary mappings dropped; `readBudgetStopScope` reads a stored run `install` as `site`.
  Policy: stage `site_deny`, codes `site_deny_rule`/`site_ask_rule`, rule scope `site`, manifest
  floor `site`. `@kobe/protocol` still _accepts_ `install_deny`, `install_deny_rule`,
  `install_ask_rule` and `run.budget_stopped` scope `install` (stored approvals, run events,
  notifications; `HISTORICAL_POLICY_NAMES`), never produces them. Frozen manifests are read with
  `withSiteNames` (same content key, so no new versions or eval refusals after the upgrade).
  Audit event schemas validate writes only: new events say `site`, old rows keep `install`.
- **Bifrost:** customer `kobe-install` → `kobe-site` through the sync: the reconcile adds
  `kobe-site`, moves every team to it, then deletes `kobe-install` (teams and virtual keys keep
  their ids and values; Kobe holds the dollar budgets, the customer carries none). Tested in
  `models/reconcile.test.ts` against the fake Bifrost.
- **Kept "install":** web search `recordId: "install"` (bound into the sealed key; renaming needs a
  re-seal), historical audit action names/categories, historical SQL migrations, stored history
  above, the `/admin/install` redirect (R1), and the verb.
- **Guard:** `scripts/site-identifiers.mjs` no longer allows the drizzle install identifiers.

## Open questions (for Chris or the coordinator)

- Old-pod error window during the upgrade: accepted by the coordinator, no compatibility views.

## Evidence (acceptance criteria → test or command output)

- **ac-1:** `packages/db/src/site-rename-migration.db.test.ts`: a database at the release before
  the rename, with rows in every renamed table, upgrades; no `install` object remains (except the
  run stop-scope check), same OIDs and relfilenodes (no rewrite), rows intact, functions work as
  the app role, grants matrix applied.
- **ac-2:** `pnpm --filter @kobe/db test:db` (catalog check, cross-team probe), tenancy registry
  and grants in `packages/db/src/tenancy/*.ts`.
- **ac-3:** `packages/cli/src/backup-restore.db.test.ts` (round trip on the renamed schema) and
  `packages/cli/src/site-rename-backup.db.test.ts` (pre-rename backup refused); both pass locally
  with libpq 18 (`KOBE_PG_BIN_DIR`).
- **ac-4:** CI on both PRs.
- **(b):** `agents/manifest.test.ts` (pre-rename manifest), `models/reconcile.test.ts` (Bifrost
  customer), `schema/runs.test.ts`, protocol `policy.test.ts`/`events.test.ts` (historical names).

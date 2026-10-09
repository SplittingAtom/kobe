# KOBE-69: CI migration upgrade-path test (main -> branch)

- **Status:** in review
- **Branch / worktree:** `kobe-69-migration-upgrade-path` in `../Kobe-wt69`
- **Depends on:** KOBE-8

## Decisions

- Reuse the harness: `createTestDatabase` honours `KOBE_TEST_BASE_MIGRATIONS` (a base migrations
  folder). It applies the base with `runMigrations`, then the branch's on top (the chart Job's
  runner), then asserts every journal entry has a `drizzle.__drizzle_migrations` row.
- Base: `scripts/upgrade-base-migrations.sh` fetches the commit and `git archive`s
  `packages/db/drizzle`. pull_request: `base.sha`; merge_group: `merge_group.base_sha`;
  push: `origin/main`.
- CI step runs only `catalog.db.test.ts` + `probe.db.test.ts` against the upgraded database (not the
  whole db suite twice).
- `assertJournalExtendsBase` fails fast on a branch migration with `when` <= base latest, or one
  missing from the base's journal (branch needs a merge).

## Evidence

- ac-1: catalog + probe, 489 tests, pass on a database upgraded from origin/main (local, ~9 s).
  CI step "Upgrade path ...".
- ac-2: `test-support/upgrade.test.ts` (out-of-order journal rejected, no DB) and
  `upgrade.db.test.ts` (Drizzle really skips the out-of-order migration; the applied-count check
  fails). No bad migration is committed.
- Added job time: ~10-15 s of tests plus a shallow fetch (CI figure: see PR).

# KOBE-416: Migration 0056 skill-review backfill reads FORCE-RLS tables as the owner

- **Status:** in review (committed locally, not pushed)
- **Branch / worktree:** `group-38-migration-0056-backfill` in `../Kobe-wt416`
- **Depends on:** none

## Plan

1. Prove it: upgrade db test from the release before 0056 with team skill versions in two teams.
2. New custom migration (0056 is never edited) doing the intended backfill with FORCE lifted
   inside its transaction, as 0140/0159/0173 do.

## Decisions

- **Confirmed bug.** Migrating through 0056 as the owner role (no BYPASSRLS, no `kobe.team_id`)
  inserts no review rows: `team_skill_versions`/`team_skills` have FORCE RLS since 0051. Such
  versions are unusable (usable needs an `approved` row) and absent from the review queue.
- **0174_skill_reviews_backfill.sql** lifts FORCE on `team_skills`, `team_skill_versions`,
  `team_skill_reviews`, inserts a `pending`, `unscanned` review row (empty findings, as 0056
  intended; the queue scans it when first listed) for every team skill version that has none
  (`NOT EXISTS` + `ON CONFLICT DO NOTHING`), and restores FORCE. Rows that exist (made since or
  decided by an admin) are never overwritten; a second run inserts nothing. Drizzle applies
  pending migrations in one transaction, so no other session sees the tables without FORCE.
- Since 0056 the server inserts the review row in the version's own transaction
  (`skills/store.ts` → `recordPendingReview`), so only pre-0056 versions can lack one.
- **gate1:** the ticket audit found 2/2 versions with review rows, so 0174 inserts nothing there.
- **ac-2** (FORCE RLS on every team table after migrate) is already asserted by
  `catalog.db.test.ts` ("enables and forces RLS on every team table and each of its partitions",
  against the fully migrated database); the new upgrade test also asserts FORCE on the three
  tables 0174 touches. No migrate-time guard added.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db/src/skill-reviews-backfill-upgrade.db.test.ts` — test 1 shows 0056 inserts
  nothing; test 2 shows full migrate backfills alpha v1 and beta v1 as pending/unscanned, keeps a
  pre-existing approved alpha v2 row, FORCE back on, idempotent re-run. Red before 0174, green after.
- ac-2: `packages/db/src/catalog.db.test.ts` RLS catalog check.
- `@kobe/db test:db` green; `@kobe/server test:db` 179 files / 2186 tests green. `pnpm verify`: two
  timing failures under load (policy perf test, chart audit-forwarding 5 s timeout) pass alone.

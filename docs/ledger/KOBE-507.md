# KOBE-507: Flaky db-core: unhandled 57P01 during personal-skills-rename-migration.db.test.ts

- **Status:** in review (group branch `group-hardening-1`, not pushed)
- **Branch / worktree:** `group-hardening-1` in `../Kobe-g-hardening-1`

## Finding

- **Terminator:** the file's own `afterAll` → `createTestDatabase().drop()` → `DROP DATABASE … WITH (FORCE)`.
  It already only touches its own database (db files run serially, `fileParallelism: false`).
- **Victim:** the last test's `createDb(appUrl)` pool (`verifyAuditChain`), closed with `app.close()`
  just before. pg-pool's `end()` resolves when its client list is empty, which happens _before_
  each client's socket closes, so the FORCE drop terminated a still-closing backend. Postgres sent
  FATAL 57P01; the idle client's listener re-emitted it as the pool's `'error'`, the pool had no
  listener, so it threw from the socket handler → vitest "1 unhandled error". Any of the ~45 db
  test files with the same close-then-drop pattern could hit it.

## Fix

- (a) `dropDatabase(admin, dbName)` in `packages/db/src/test-support/database.ts`: waits up to 5 s for
  the database's own sessions (`pg_stat_activity.datname = dbName`) to end, then drops WITH (FORCE).
  Used by `createTestDatabase().drop()` and `audit-upgrade.db.test.ts`.
- (b) `installPoolErrorLogger()` (`test-support/pool-errors.ts`, re-exported from `@kobe/db/testing`),
  installed for every db test by `src/testing/db-setup.ts` (vitest.db `setupFiles`): a 57P01 pool
  `'error'` with no listener is logged (`console.warn`); any other error still throws (review). Pools
  with their own listener unchanged. `dropDatabase` warns with the db name and session count when
  the 5 s grace runs out (review).
- Production `createDb` unchanged (no error handler there; out of scope).

## Evidence

- `src/test-support/pool-errors.db.test.ts`: RED before the fix reproduced the exact CI error
  (uncaught 57P01 from pg-protocol) and a closing client terminated by `drop()`; GREEN after.
- Full `pnpm --filter @kobe/db test:db` (CI config, serial files), 3 runs: see below.
  - Run 1: 98 files, 1600 tests passed, 0 errors (227 s).
  - Run 2: 98 files, 1600 tests passed, 0 errors (255 s).
  - Run 3: 98 files, 1600 tests passed, 0 errors (276 s).
  - No pool-error warnings logged in any run. ac-1 asks for 10 runs; 3 done here, CI adds more.
  - Run 4 (after review fixes): 98 files, 1601 tests passed, 0 errors.
- `pnpm --filter @kobe/db test` (739 passed), typecheck, eslint, prettier: clean.

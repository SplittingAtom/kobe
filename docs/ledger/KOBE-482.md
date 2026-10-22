# KOBE-482: Test harness: a separate test database per agent lane

- **Status:** in review (group-42, not pushed)
- **Branch / worktree:** `group-42-lane-test-dbs` in `../Kobe-wt482`
- **Depends on:** none

## Decisions

- Isolation was already one throwaway database per suite or file; lanes add a per-worktree
  maintenance database `kobe_lane_<lane>` (created in every DB suite's global setup) and suffix
  every throwaway database and role with `_<lane>`, so a lane's leftovers can be listed and dropped
  (`pnpm --filter @kobe/db test:lanes [drop <lane>]`) without touching another lane's.
- Lane = `KOBE_TEST_DB_LANE`, else the worktree directory name (`Kobe-wt482` → `wt482`); none when
  `CI` is set (turbo passes `CI` through to `test:db`), so CI is unchanged.
- No setup ever drops a role it did not create; no shared roles exist.
- The dev Postgres holds ~400 lane-less `kobe_test_<hex>` leftovers from older crashed runs; left
  alone (they may belong to a running pre-lane checkout).

## Evidence

- ac-1: full server DB suite in `Kobe-wt482` and a throwaway `Kobe-wt482b` at the same time,
  default 4 workers each: both 182 files / 2219 tests passed (600 s each), no leftovers.
- ac-2: `docs/parallel-work.md` (Shared environments → Postgres for tests); `lane.test.ts`
  (resolution, names), `lane.db.test.ts` (racing create, list, drop only own lane).

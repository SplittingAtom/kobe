# KOBE-229: Index memory_doc_versions (team_id, run_id, tool_call_id) for remember idempotency

- **Status:** in review (PR #253)
- **Branch / worktree:** `kobe-229-memory-versions-index` in `../Kobe-wt229`
- **Depends on:** KOBE-156 (merged)

## Plan

One migration-only PR (migration, schema comment, install note, DB test): no service code changes,
since `replayOf` in `services/server/src/memory/agent.ts` already filters on exactly these columns.

## Decisions

- **Migration `0092_memory_versions_tool_call_idx`** (custom/SQL-only, like 0042 and 0087):
  `CREATE INDEX IF NOT EXISTS memory_doc_versions_tool_call_idx ON memory_doc_versions
(team_id, run_id, tool_call_id) WHERE run_id IS NOT NULL AND tool_call_id IS NOT NULL`.
- **Predicate** also requires `run_id`: panel restores carry a `restore:<n>` tool_call_id but no
  run, and people's writes have neither, so only agent writes are indexed. The lookup's equalities
  imply the predicate, including in a generic plan (tested).
- **Not unique.** Idempotency is already enforced by the per-call advisory lock plus the lookup. A
  unique index would fail the migration on any duplicate an install might hold, or need rows
  deleted; a plain index adds no failure mode and deletes nothing.
- **Lock impact.** Drizzle runs all migrations in one transaction, so `CONCURRENTLY` is impossible
  here. The plain build holds a SHARE lock on `memory_doc_versions` for the scan: reads continue,
  writes (new versions, restores, cascaded deletes) wait. The table has one small row per memory
  write, so the build is brief. Large sites can pre-build it `CONCURRENTLY` with the same
  definition (`IF NOT EXISTS` then skips it); documented in `docs/install.md`, "Upgrading".
- **Grants:** an index needs none; `migrate.ts` records `kobe_grants_applied` for the newest
  migration automatically, as for every migration.
- Schema keeps a comment pointing at the SQL-only index (as `threads.ts` does for 0042).

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- **ac-1** `packages/db/src/memory-replay-index.db.test.ts`: checks the index definition, then as
  the app role inside `withTeam()` (RLS on) with 2 × 2000 seeded versions and ANALYZE, EXPLAINs the
  replay statement with values and as a prepared generic plan; the only scan of
  `memory_doc_versions` must be `memory_doc_versions_tool_call_idx`. Generic plan excerpt:

  ```text
  ->  Index Scan using memory_doc_versions_tool_call_idx on memory_doc_versions v  (cost=0.28..60.64 rows=1 width=36)
        Index Cond: ((team_id = $1) AND (run_id = $2) AND (tool_call_id = $3))
  ```

- `@kobe/db` DB suite (`vitest -c vitest.db.config.ts`, dev Postgres): 41 files, 1068 tests
  passed, incl. catalog (RLS) and the cross-team probe.

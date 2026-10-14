# KOBE-215: Migration: threads pinned_at, archived_at, forked_from_thread_id, forked_at_entry_id, title_locked

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #280)
- **Branch / worktree:** `kobe-215-thread-org-migration` in `../Kobe-wt215`
- **Depends on:** — (lands alone, before KOBE-216 fork to thread, 219 auto-titles, 220 pin/archive/move)

## Plan

Migration-only (CE16, CE18, CE19): columns, constraints and indexes on `threads`, the fork key,
probe fixtures, and the additive protocol fields. No route, query or UI change (ac-3).

## Decisions

- **Two migration files.** `0095_thread_organization.sql` is drizzle-generated (columns, CHECKs,
  indexes). `0096_thread_fork_fk.sql` is a `--custom` migration holding only the fork key,
  because drizzle cannot write `ON DELETE SET NULL (column)`. That is the 0086/0087 schedules
  pattern; `db:rebase` regenerates the first and re-creates the second.
- **`forked_from_thread_id`:** composite FK `threads_forked_from_fk` (team_id,
  forked_from_thread_id) → threads (team_id, id) `ON DELETE SET NULL (forked_from_thread_id)`.
  The column list exists only on PostgreSQL 15 and later; the chart (CNPG `postgresql:17`) and CI
  (`postgres:17`) both run 17. Deleting the source (retention purge, Trash purge, Delete forever,
  team deletion) never deletes a fork, never blocks on one, and never nulls `team_id`. It is
  declared SQL-only, like `threads_schedule_fk`, and documented in `schema/threads.ts`. CHECK
  `threads_fork_not_self` refuses a thread that forks itself.
- **`forked_at_entry_id`:** kept as provenance text with no FK. Reasons:
  1. `forkThread` (services/server/src/threads/fork.ts) copies the entries up to the fork point
     _with their ids_, so this id is also an entry of the fork itself. It stays meaningful after
     the source is purged.
  2. An FK to the source's `thread_entries` would need its own SET NULL. When a thread is
     purged, the cascade over its entries and the thread key's SET NULL would then race against
     any cross-column CHECK, in whatever order the RI triggers happen to fire. It would also add
     an RI check for every entry of every purged thread.
  3. The suggested CHECK ("null whenever `forked_from_thread_id` is null") can't hold together
     with SET NULL on the link: the purge would clear the link, keep the entry id, and fail the
     CHECK, which would block the purge. Keeping both columns null together would need a
     trigger, and would throw away the fork point.

  So the column carries only a length CHECK (1–128, like `thread_entries.entry_id`). Source null
  with an entry id set means "forked from a thread that no longer exists". The writer (KOBE-216)
  sets both columns, or neither.

- **`title_locked`** is `boolean NOT NULL DEFAULT false`. The default is a constant, so adding the
  column only changes metadata and rewrites nothing. **`pinned_at`** and **`archived_at`** are
  nullable `timestamptz`.
- **Indexes** (team_id first, partial, so each holds only the rows it serves):
  - `threads_owner_pinned_idx` (team_id, owner_user_id, pinned_at DESC, id DESC) WHERE pinned_at
    IS NOT NULL AND deleted_at IS NULL. It serves the Pinned group, which is sorted by pin time
    (CE19). `threads_owner_activity_idx` can't serve that order, and pinned threads older than
    the loaded page would otherwise never be found.
  - `threads_forked_from_idx` (team_id, forked_from_thread_id) WHERE forked_from_thread_id IS NOT
    NULL. The SET NULL lookup needs it on every purged thread; without it each purge would scan
    the team's threads.
  - **No index for non-archived threads.** Today the list (`listThreads`) filters `deleted_at IS
NULL AND NOT is_test` and orders by activity. A partial index adding `archived_at IS NULL`
    would have the same keys as `threads_owner_activity_idx`, and today's query couldn't use it,
    so it would only add write cost. An archive filter can ride on the activity index; archived
    threads are a minority. See the open question.
- **Locking.** ADD COLUMN takes ACCESS EXCLUSIVE on `threads`, held until the migration commits.
  The two CHECKs and the FK validation each scan the table once (the new columns are all null).
  The two partial `CREATE INDEX` statements also scan `threads` once each. `threads` is small next
  to `thread_entries` and `events`, so plain builds (not CONCURRENTLY) are fine.
- **Registry and RLS.** No new table and no policy change. `tenancy/conversations.ts` already
  lists `threads` and its policy covers every column, so the registry is unchanged. The probe
  fixture (`probe-fixtures/conversations.ts`) now inserts a pinned, archived, title-locked fork,
  so the new key is exercised on every probe run.
- **Protocol.** Added `threadOrganizationSchema` in `packages/protocol/src/threads.ts`: five fields
  that decode as null/false when absent, so the change is additive, like
  `scheduleThreadMarkerSchema` (KOBE-171). The server's `threadSummarySchema`, `openapi.json` and
  the web types are untouched: spreading the schema in means the server must send the fields,
  which is app behaviour and belongs to KOBE-216/219/220. The repo has no snapshot test of the
  protocol schemas; the new unit tests in `threads.test.ts` cover the fields.

## Open questions (for Chris or the coordinator)

- KOBE-220 decides how the rail asks for Archived threads. If it becomes a separate paged query
  and archives grow large, it may want an `archived_at`-ordered partial index. That would be a new
  migration, which the spec ("one threads migration") did not plan for. Raise it in KOBE-220's
  plan if needed.

## Evidence (acceptance criteria → test or command output)

- **ac-1:** columns, constraints and indexes are in `packages/db/drizzle/0095_thread_organization.sql`
  and `0096_thread_fork_fk.sql`. `packages/db/src/thread-organization.db.test.ts` covers the
  defaults, a link inside the team, refusal of another team's or a missing source (23503) or of
  a self-fork (23514), the kept fork, purging a source and its forks in one statement, team
  deletion, and the constraint definition. The probe suite (`probe.db.test.ts`, "cross-team
  references") shows a fork can't name team B's thread by its exact id. Both suites are green,
  as is the catalog check (`pnpm --filter @kobe/db test:db`).
- **ac-1 (purge paths):** `services/server/src/retention.db.test.ts` has two tests. "purges a
  fork's source, never the fork" runs the nightly pass over a retention-expired source and a
  Trash-expired source. "keeps the thread's forks, clearing only their link" covers Delete
  forever (`pnpm --filter @kobe/server test:db`).
- **ac-2:** `packages/protocol/src/threads.test.ts`, "thread organization fields".
- **ac-3:** the diff touches only `packages/db` (schema, migrations, fixtures, tests),
  `packages/protocol` (schema and tests), the server's retention test and this ledger.

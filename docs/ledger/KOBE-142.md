# KOBE-142: Migration: files table and team storage quota (53b)

- **Status:** in review
- **Branch / worktree:** `kobe-142-files-migration` in `../Kobe-wt142`
- **Depends on:** KOBE-27

## Plan

Migration-only PR (ac-3): schema `packages/db/src/schema/files.ts`, migrations `0071_files`
(generated) and `0072_files_rls` (custom), tenancy entries in `tenancy/workspace.ts`, probe fixtures,
`BLOB_REF_COLUMNS` entry, `files.db.test.ts`. No server, web or sandbox code.

## Decisions

- **`files`**: columns as in the ticket. PK and every FK carry `team_id`. Thread reference is
  `(team_id, thread_id)` -> `threads(team_id, id)` **ON DELETE CASCADE** (as `thread_entries` and
  artifacts): thread purge removes the rows after retention queues their `blob_ref`s (KOBE-18).
  `thread_id` is nullable (MATCH SIMPLE: no check when null), so unthreaded uploads survive.
  `run_id` -> runs `(team_id, run_id)` without cascade. Unique `(team_id, tool_call_id)` is a partial
  unique index (`WHERE tool_call_id IS NOT NULL`). Checks: kind, scan_status, name length, size >= 0,
  sha256 shape.
- **Blob registry**: `files.blob_ref` with `thread: true` (the purge hook stub: nothing else needed
  in db; the server stores threaded objects under `teams/<team>/threads/<thread>/`). Unthreaded
  files are outside any thread tree and are deleted by the feature PR (KOBE-53) when the user
  deletes them.
- **Quota: table `team_storage_quotas`** (`team_id` PK, `max_bytes` null = install default,
  `updated_by/_at`), not a column on `teams`: `teams` has no team RLS, while team settings
  (`team_retention`) are team tables edited under `withTeam()` by team admins. No row = default.
- **RLS**: both tables ENABLE + FORCE with the canonical `team_isolation` policy (0072).
  Legal hold: statement-level delete guard and truncate guard on `files`, keyed on the file owner
  (`legal_hold_covers(team, user_id)`), since a file need not have a thread.
- **No `break_glass_read` on files**: not thread-bound; read-side design belongs to the feature PR
  (it must then be added to `BREAK_GLASS_READABLE_TABLES` with a policy).

## Open questions (for Chris or the coordinator)

- Break-glass read for files (above): add in the feature PR, or want it now?

## Evidence

- ac-1: probe suite (`probe.db.test.ts`) runs the new fixtures; `files.db.test.ts` covers checks,
  uniqueness, cross-team FKs, cascade, legal hold, quota.
- ac-2: `blob-refs.test.ts` (registry check) green.
- ac-3: `db:check`, journal order test, `pnpm --filter @kobe/db test:db` green.

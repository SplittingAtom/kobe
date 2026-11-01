# KOBE-534: Threads: Folders (db, server) (TLF-3)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (two branches; the coordinator opens the PRs)
- **Branch / worktree:** `kobe-534-folders-schema` (migration PR, packages/db only) and
  `kobe-534-folders` (server, on top of it) in `../Kobe-wt534`
- **Depends on:** KOBE-532 (protocol shapes, on this branch as 081774bf)

## Plan

1. Schema PR: `thread_folders` (TF1), `threads.folder_id` (TF2), generated `0186_thread_folders`
   plus custom `0187_thread_folders_rls` (RLS, name key, tree trigger, thread key, check, index),
   tenancy entry, probe fixtures, upgrade test, `docs/install.md` upgrade note.
2. Server PR: `lockForFiling` + `POST /v1/threads/{id}/file` (TF3), `/v1/thread-folders` CRUD
   (TF4, `routes/thread-folders.ts` + `threads/folders.ts`), `folder` filter on `GET /v1/threads`
   and `/pinned` with per-viewer counts (TF5), `folder_id` in every summary (list, detail, search),
   fork inheritance and export path (TF9), audit events (TF11), OpenAPI.

## Decisions

- **Check and index are SQL-only** (`0187`), like KOBE-220/221's: `threads_folder_not_test` is
  `NOT VALID` (0186's ADD COLUMN holds ACCESS EXCLUSIVE on threads until commit; every row is null)
  and covers `is_test`, `skill_test` and `skill_eval`; `threads_folder_idx` is `IF NOT EXISTS`.
  Named in `schema/threads.ts`. The upgrade note says the index can only be pre-built on a
  re-run (the column is new), as KOBE-221's note does.
- **Trigger** `thread_folders_guard_parent` (BEFORE INSERT OR UPDATE OF parent_id; skips an
  unchanged parent) walks the new parent's ancestors (cycle when it meets the folder itself:
  SQLSTATE `KF002`), then adds the moved folder's subtree height (depth > 3: `KF001`). It takes a
  per-team transaction advisory lock (`hashtextextended('kobe.thread_folders:' || team_id, 0)`)
  so two concurrent moves cannot form a cycle together; the server's create (500 limit) and
  delete take the same lock.
- **Error mapping:** the route catches the rolled-back transaction's error and maps `KF001` →
  `folder_too_deep`, `KF002` → `folder_cycle`, 23505 on `thread_folders_name_unique` →
  `folder_name_taken` (`folderErrorOf`), so a refused change leaves no row and no audit row.
- **Lock order:** filing holds the target folder (`FOR KEY SHARE`) before the thread row; a folder
  delete locks its whole subtree `FOR UPDATE` before the cascade nulls threads. Same order both
  ways, so no deadlock between a filing and a delete. The thread lock is `FOR NO KEY UPDATE` like
  `lockForChange` (KOBE-266), not the spec's literal `FOR UPDATE`.
- **Fork (TF9):** the fork holds the source's folder (`KEY SHARE`) before the insert; a folder
  deleted meanwhile gives a null folder instead of a foreign-key error (the key's SET NULL only
  covers rows that exist at delete time).
- **List semantics:** `?folder=<id>` = live, unarchived, readable (own or `/shared` predicate),
  minus the caller's own pinned ones (those are in `/pinned?folder=`, as the default list leaves
  pinned out). Counts (`GET /v1/thread-folders`) include the caller's pinned ones, so a folder's
  count = its list + its Pinned list. `folder` with `q` or `project_id` is 400; `/archived` and
  `/shared` refuse `folder` (strict query).
- **Search** hits carry `folder_id` too (`packages/db` `thread-search.ts`), for TF10's path note.
- **Folder delete audit:** `threads` counts every thread (any owner, Trash included) taken out
  of the deleted folders.
- **Export:** `threads.json` entries gain `folder: "A/Sub"` (names joined with `/`; a `/` inside a
  name is not escaped, as the spec's format has no escape).
- `thread_folder.*` adds the audit category `thread_folder` (first segment of the action): the
  category list in `packages/db` test, `apps/web/lib/admin/api/site/audit.ts` (drift test) and
  `docs/audit-log.md` gain it.
- Rate limit key `folder-create:<user id>`, 60 per 10 minutes (fork's shape).

## Open questions (for Chris or the coordinator)

- The `threads_folder_fk` SET NULL lookup on a folder delete cannot use `threads_folder_idx`
  (partial on `deleted_at IS NULL`); it reads the team's threads by primary-key prefix. Fine at
  current sizes; a non-partial (team_id, folder_id) index would serve it if it ever matters.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/thread-folders.db.test.ts` "folders (ac-1)" (CRUD by two members,
  actors in audit, every error, 501st refused); trigger via direct SQL in
  `packages/db/src/thread-folders-upgrade.db.test.ts`.
- ac-2: "filing (ac-2)" (owner, reader, stranger 404, Trash, `is_test`/`skill_test`, other team's
  folder, idempotent, axes kept, `thread.filed` on change only).
- ac-3: "delete, Trash, archive and forks (ac-3)"; cascade + SET NULL also in the upgrade test.
- ac-4: "listing a folder (ac-4)" (own + shared only, counts, `none`, `/pinned?folder=` paging).
- ac-5: probe fixtures (`thread_folders`, a filed thread) in `probe.db.test.ts`; "teams never
  cross (ac-5)"; upgrade test on a populated database; `threads-plans.db.test.ts` covers the
  folder list, Pinned list, counts and filing lock.
- ac-6: "export (ac-6)" (`folder: "Finance/2027"`).

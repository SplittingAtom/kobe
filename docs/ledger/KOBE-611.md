# KOBE-611: TFM-2: reads for thread-file links (server, protocol, OpenAPI)

- **Status:** done in branch (group `thread-file-map`), not pushed
- **Branch / worktree:** `kobe-610-thread-file-links` in `../Kobe-wt610`
- **Depends on:** KOBE-610 (table and recording)

## What

- Protocol `packages/protocol/src/thread-file-links.ts`: schemas, caps
  (`THREAD_FILE_LINKS_MAX_THREADS` 50, `FILE_THREADS_MAX_PATHS` 100, 200 files per thread, 20
  threads per path), `listParameter`.
- Routes `services/server/src/routes/thread-file-links.ts`, read queries
  `thread-file-links/read.ts`, OpenAPI `openapi/thread-file-links.ts` (openapi.json regenerated):
  - `GET /v1/threads/file-links?threads=…` → `{links:[{thread_id, files, hidden_count}]}`;
    unreadable ids left out.
  - `GET /v1/threads/{id}/file-links` → `{thread_id, files, hidden_count}`; 404 when not readable.
  - `GET /v1/workspace/file-threads?paths=…` → `{files:[{path, threads:[{thread_id, title,
access, last_at}], more}]}`.
- Privacy (TFM7): threads via `findThreads`/`findThread` (`readableBy`); files named only when
  `owner_user_id = viewer` or the project is in `viewer.projectIds`; everything else counted.
  Project files are named `projects/<current slug>/<path>`.

## Decisions

- **Contract change (coordinator, 2026-11-10):** the per-thread read lives at
  `GET /v1/threads/{id}/file-links`, not `/files`, since `GET /v1/threads/{id}/files` is KOBE-488's
  agent-written-files contract and is left as it is. The router is mounted before the other
  `/threads` routers, `/file-links` is registered before `/:id/file-links`, and the id must be a uuid.
- List parameters: a single value is split on commas; repeated values are taken whole, so a path
  that contains a comma can still be sent. Duplicates are dropped; unknown parameters give 400.
- `access` = `write` if any row wrote the file; `last_at` = the latest; `deleted` only when every
  row is deleted.
- Files beyond the 200-per-thread cap count in `hidden_count`. Threads beyond 20 per path, in
  Trash, test or eval threads, and unreadable threads count in `more`.

## Evidence

- ac-1: `openapi/document.test.ts` (route set equals the documented paths, file in sync), protocol
  `thread-file-links.test.ts`, route validation cases in `thread-file-links-reads.db.test.ts`.
- ac-2: `thread-file-links-reads.db.test.ts` 7/7: owner, a teammate's shared thread (project
  files by name, the sharer's file counted), cross-team (nothing, 404), Trash counted.

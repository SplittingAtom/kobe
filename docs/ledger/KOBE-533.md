# KOBE-533: Threads: Lineage read (server) (TLF-2)

- **Status:** in review (coordinator opens the PR)
- **Branch / worktree:** `kobe-533-lineage-read` in `../Kobe-wt533`
- **Depends on:** KOBE-532 (protocol shapes, commit 081774bf)

## Plan

`GET /v1/threads/{id}/lineage` (spec TL1, TL2): route in `routes/threads.ts`, OpenAPI entry
`getThreadLineage` + `ThreadLineage` schema, logic in `services/server/src/threads/lineage.ts`.

## Decisions

- **One transaction:** the route's `asViewer` (one `withTeam()`); inside it `findThread`
  (1 query), the walk (1 query per generation, at most `LINEAGE_MAX_DEPTH`), then one forks
  query over `threads_forked_from_idx` (`forked_from_thread_id IN (path + self)`, ranked with
  `row_number() OVER (PARTITION BY forked_from_thread_id ORDER BY last_activity_at DESC, id DESC)`,
  `rank <= 51` so a cut list is known). `asViewer` also reads the viewer's project ids first, as
  every thread route.
- **Readable predicate:** `readableBy(viewer)` from `threads/repository.ts`, now exported; the same
  one `findThreads` uses for `forked_from_title`. It already matches TL2 for Trash: own threads in
  Trash (within retention) are readable, others' never (`sharedWith ... AND deleted_at IS NULL`).
- **Never listed:** `NOT is_test AND NOT skill_test AND NOT skill_eval` on the walk and the forks
  (builder test, Workbench test chat, eval). An ancestor failing it stops the walk as hidden.
- **Hidden ancestor:** the walk stops with `root_hidden: true`; the topmost readable thread then
  gets `siblings: []` even when other readable forks of the hidden parent exist (listing them
  would hint at the hidden parent). Same `[]` at a true root and below a purged ancestor.
- **Path thread kept in its own sibling list:** when a list is cut at 50 and the thread on the
  path falls past the cut (it is then older than all 50), it replaces the 50th entry, so the strip
  can always check it ("n of N").
- **Depth cap:** a chain longer than 20 shows the 20 nearest ancestors, `root_hidden: false`
  (the thread above is readable, just not shown; the flag means "can't open").
- The asked thread itself only needs to be readable (as other reads); a test/eval thread has no
  family anyway (never forked).
- `team_id` stated explicitly in both queries (`team-filter` guard).

## Open questions (for Chris or the coordinator)

- None blocking. Depth-cap semantics above are an interpretation of TL1 ("the chain stops there").

## Evidence (acceptance criteria → test or command output)

- ac-1..ac-5: `services/server/src/threads/lineage.db.test.ts` (10 tests, all pass against the dev
  Postgres): family of three generations with two forks at one level (ac-1); hidden ancestor
  reveals no id/title/sibling, purged ancestor shortens the chain with no flag (ac-2); D23 reader,
  404 `thread_not_found` for a stranger, another team and an unknown id, test/Workbench/eval
  absent (ac-3); owner's Trash listed with `deleted_at`, not for a reader (ac-4); depth 20,
  50 siblings/forks with `*_more`, statement count = 2 + walk steps, counted with a proxy over the
  transaction (ac-5). Every answer parses with `threadLineageResponseSchema`.
- Unit: `services/server/src/threads/lineage.test.ts` (caps, assembly, hidden root).
- `pnpm verify` (excludes `*.db.test.ts`; the db file was run separately with
  `pnpm --filter @kobe/server exec vitest run -c vitest.db.config.ts src/threads/lineage.db.test.ts`).

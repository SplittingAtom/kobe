# KOBE-220: C2: Pin, archive, move to project

- **Status:** committed on `group-3-phase-c-org` (ticket group G3, Phase C; no PR of its own)
- **Branch / worktree:** `group-3-phase-c-org` in `../Kobe-g3`
- **Depends on:** KOBE-215 (`pinned_at`, `archived_at`, `threads_owner_pinned_idx`), KOBE-198
  (rail groups), KOBE-161 (`canCreateInProject`), KOBE-292 (row menu, command registry)
- **Migrations (KOBE-234 pattern, review M1):** `0103_thread_project_moves.sql` (generated, the
  column only: constant default, catalog-only) and custom `0104_thread_project_moves_checks.sql`:
  `threads_project_moves_shape` CHECK (array, at most 20) `NOT VALID`, and
  `CREATE INDEX IF NOT EXISTS threads_owner_archived_idx` (docs/install.md "Upgrading": build it
  CONCURRENTLY first on a large site). db:rebase dry run in a throwaway worktree: generated ones
  merged into one, 0104's SQL kept verbatim, then `drizzle-kit generate` "No schema changes";
  `db:check` clean on the branch.

## What changed

- **Server routes** (`routes/threads.ts`, logic in `threads/organize.ts`):
  `POST /v1/threads/{id}/pin|unpin|archive|unarchive` and `POST /v1/threads/{id}/move`
  `{ project_id: uuid | null }`; `GET /v1/threads/pinned` and `/archived` (keyset pages, newest
  pin/archive first, as Trash). All owner only through `lockForChange` (another member 404, a
  project reader 403 `read_only`), refused in Trash (`thread_in_trash`) and for builder test
  threads (`test_thread`), idempotent. None touches `last_activity_at`.
- **Pinned and Archived are exclusive:** archiving unpins; pinning an archived thread is 409
  `thread_archived`. Re-pinning keeps the first pin time (the group order doesn't jump).
- **The activity list** (`GET /v1/threads` without `project_id`) now leaves out pinned and archived
  threads, so the rail can page it without listing a thread twice. With `project_id` it is
  unchanged (pinned and archived included: they are the owner's own organization, not the
  project's). Summaries carry `pinned_at` and `archived_at` (also search hits).
- **Rail** (`thread-list-adapter.ts`, `thread-groups.ts`, `rail-threads.tsx`): the first list read
  is pinned (100) + activity page + archived (100) + Trash; later pages are the activity list only.
  Groups: Pinned (pin time) → projects → Your threads → Scheduled → Shared with me → Archived
  (folded, CE5) → Trash. A project now wins over Scheduled, so a moved scheduled thread sits under
  its project. Older archived threads beyond the 100 newest are reached through search.
- **Row menu** (`use-organize-menu.ts`, bound in `thread-row-menu.tsx`, commands `pin-thread`,
  `unpin-thread`, `move-thread`, `archive-thread`, `unarchive-thread` in `lib/shell/commands.ts`):
  Pin or Unpin, Move to project (submenu: "No project" and the member's live projects,
  `session.projects()` = `GET /v1/projects`, "(current)" marked), Archive or Unarchive. Move shows
  why it is unavailable (loading, failed, a run going or queued, no projects). Read-only rows get
  Pin/Archive blocked with the reason.
- **Drag onto a project header** moves the thread (`THREAD_DRAG_TYPE`, own rows only, outline in
  the accent token while over). The menu is the keyboard path.
- **Immediately, after reload, other tabs:** after the server answers, `session.organize` reloads
  the list and refreshes the open thread, and posts to a per-team `BroadcastChannel`
  (`thread-list-sync.ts`); other tabs of the browser reload too. No run stream carries these
  changes and there is no protocol event for them (a contract PR would be needed); other devices
  see them on their next list read (focus, a new thread, a title).
- **Accessibility:** one polite live region for the rail (`data-kobe-rail-status`) says what
  happened, since a moved row is remounted in its new group; focus follows the row's menu button,
  or the folded group's toggle (Archived). Refusals show in the row and the live region. Both
  themes: only `theme.css`/admin tokens (`--admin-accent`, `--admin-border`, muted).
- **Search** marks archived hits ("Archived" badge, `data-kobe-archived`).
- **Retention:** unchanged code; archive and pin never count as activity. Test added.

## Move semantics (ac-2)

- **Who:** the owner, where `canCreateInProject` holds (member or team admin, project not
  archived), the same check as `POST /v1/threads` with `project_id`; otherwise 404
  `project_not_found` (a non-member can't tell the project exists). `null` moves it out.
- **Refused while a run is queued or running** (`thread_busy`): that run's context, memory scope
  and project proposals are the old project's.
- **Sharing:** a thread shared to its old project becomes private (audited
  `thread.sharing_changed`); its new project's members never inherit it. Move is audited
  `thread.moved { threadId, from, to }` (docs/audit-log.md).
- **Bound sandbox:** nothing to rebind. The sandbox is one per (team, user) (D11) and its
  workspace mounts every project the member belongs to under `/workspace/projects/<slug>`
  (KOBE-162, membership-based, not thread-based), so the move changes no files, mounts or Pi
  session (history stays). What changes is per run: `run.start.project` is read from the thread at
  every start (`runs/lifecycle.ts`), so the next run gets the new project's instructions and mount
  in the per-run context file (no Pi restart), and project memory and policy follow
  `threads.project_id` live. Earlier answers may name the old project's paths; those stay readable
  while the member is still in that project.
- **Marker:** each move is kept in `threads.project_moves` (newest 20, `{at, from, to, runs}`;
  `at` is `clock_timestamp()`, `runs` the count of message runs started at the move, review L1:
  the marker goes on the next started run by count, since a run's `started_at` is its
  transaction's start and can precede a move it waited for on the thread lock);
  `GET /v1/threads/{id}/markers` gains `projects`: one marker per first message run that started
  after a move (several moves before a run collapse to first `from` → last `to`; a round trip
  shows none). Id and name only for projects the viewer may open; otherwise `*_hidden` and
  "Moved to another project" (review L2). The chat shows "Moved to project X ·
  its instructions apply from here" above that run's prompt. The agent learns the project from that
  run's context ("This conversation belongs to the project …"), not the history of moves.

## Decisions

- Archived index added (the KOBE-215 open question): the Archived group is its own paged query.
  EXPLAIN (ANALYZE, BUFFERS) on 100k threads, one owner with 5,000 (2% archived):
  - with `threads_owner_archived_idx`: Index Scan, 31 rows read, no sort, 0.045 ms;
  - without: Bitmap Index Scan of `threads_owner_activity_idx` (5,000 rows) + heap filter
    (4,900 removed) + top-N sort, 0.89 ms, growing with the owner's thread count.
  - Pinned uses KOBE-215's `threads_owner_pinned_idx` the same way (Index Scan, 25 rows).
  - The ordering is written `DESC NULLS LAST` to match both indexes (plain `DESC` adds a sort).
  - The activity list's plan is the same before and after the new filters (Index Scan Backward on
    `threads_retention_idx`, 610 vs 590 rows filtered).
- The move record is a column, not a table ("no new team tables"); runs are not changed (no
  `runs.project_id`), so no backfill and no run-path change.

## Open questions (for Chris or the coordinator)

- The Archived group shows the newest 100; older archives are found by search. A "Load more" for
  that group would need its own cursor in the rail.

## Evidence (acceptance criteria → test or command output)

- **ac-1:** `services/server/src/thread-organize.db.test.ts` ("pin and unpin", "archive and
  unarchive", "who may organize"); web `components/chat/thread-organize.test.tsx` (pin to the top
  and back, kept after a remount; archive into the folded group with the focus on its toggle;
  another tab's change reloads), `lib/chat/thread-groups.test.ts`,
  `lib/chat/thread-list-adapter.test.ts`, `lib/chat/thread-list-sync.test.ts`.
- **ac-2:** db test "move to project" (allowed, audited, refused for non-member / archived /
  unknown project like thread creation, another team's project, another team's member, the
  DB cap, unshared, refused while busy and for a test thread, next
  run's `run.start.project` is the new project and its marker, names hidden from non-members);
  web tests (submenu, refusal wording, drop on a project header, the marker row);
  `lib/chat/tree-markers.test.ts` (placement above the prompt).
- **ac-3:** db test "keeps archived threads searchable, marked as archived";
  `retention.db.test.ts` "purges archived and pinned threads by their activity like any other";
  web search badge test.
- **Plans:** `threads-plans.db.test.ts` covers the new list, change and marker queries
  (team-leading indexes with the break-glass policy).
- **Browser:** `e2e/browser/tests/organize.spec.ts` (fails until this branch is deployed: the
  routes and the menu entries are new); `row-menus.spec.ts` lists the new entries.

# KOBE-304: Files panel as a compact file tree with file-type icons, move and rename

- **Status:** in review (group branch `group-2-quality`, no PR of its own; Opus security review next)
- **Branch / worktree:** `group-2-quality` in `../Kobe-g2`
- **Depends on:** KOBE-148 (browser), KOBE-199 (rail drop), KOBE-223 (mention rules), KOBE-268
  (file tabs), KOBE-275 (silent hold pattern), KOBE-292 (row menu)

## Plan

1. Contract `workspaceMoveRequestSchema` / `workspaceMoveResponseSchema` (protocol `files.ts`),
   audit `workspace.file_moved` and `retention.workspace_hold_history_purged`.
2. `workspace_file_hold_history` (0114 generated, 0115 custom: RLS, hold guard, immutability).
3. Server `POST /v1/workspace/files/move` (`routes/workspace-move.ts`, `workspace-sync/move.ts`),
   schedules' mentions follow (`schedules/mention-moves.ts`), retention purge after release,
   offboarding deletes released copies.
4. Sandbox agent: folders emptied by a server move or delete are removed.
5. Web: icon mapping (`lib/files/icons.ts`), tree rules (`lib/files/tree.ts`), `use-file-tree`,
   `file-tree.tsx` (ARIA tree, keys, DnD), `file-dialogs.tsx` (delete, rename, Move to…),
   `file-browser.tsx` (container), tabs follow moves, computer drops onto a tree folder.

## Decisions

- **Move protocol: manifest-first, one transaction** under `withTeam()`, legal-hold lock (shared)
  then the workspace row lock (same order as delete and collection). New rows at the new paths
  first (same `sha256`, object key, size, mtime, mode; origin `server`), then the old rows become
  tombstones; revisions in that order so a paged pull never sees a file in neither place. S3 is
  not touched (content-addressed keys; collection only frees content no live row references).
  The sandbox follows on its next pull (periodic, before each run, on wake) like any server
  write: new path downloaded, old one removed if unchanged, an unsynced edit of the old path kept
  and pushed back there (nothing lost). No new wire frame (contract change avoided). A crash rolls
  the whole move back; a retry after a commit gets 404 and the UI lists again. Up to 10 000 files
  per move (as delete), set-based SQL.
- **Rules (server):** both paths pass `workspacePathSchema`; the new path also `mentionPathIssue`
  (KOBE-223: no control, format, default-ignorable, bidi or shell characters, length caps);
  `.kobe/` hidden (404 as source, 400 as target); project mounts and thread uploads read-only both
  ways; a member's drop may move out, a file may move into `uploads/` (becomes a drop), a folder
  may not; not onto or into itself; a live file at, under or above the target refuses
  (`already_exists`, never overwritten); every derived path re-checked (too long: 422).
- **Legal hold (KOBE-275 pattern):** the move answers exactly as without a hold. One INSERT copies
  each moved file's old path, new path, sha256, object key, size, mtime and revision into
  `workspace_file_hold_history` filtered by `legal_hold_covers()` in SQL (no branch in the app).
  Immutable, delete/TRUNCATE refused while held, no break-glass read (like `workspace_files`),
  purged by the retention pass after release, deleted by offboarding once not held. Collection
  already skips held workspaces, so content stays. (The existing file-browser _delete_ still
  answers 409 `legal_hold`; unchanged here.)
- **Audit** `workspace.file_moved` `{userId, files, bytes}` only. **Rate limit** 60 moves per
  member per minute (`MOVE_RATE_LIMIT`). Lock wait 5 s, then 503 `busy`.
- **References (ac-9):** the owner's schedules in the team that mention a moved path get the new
  path in `mentions` and their prompt markers, in the move's transaction (unless the new path
  breaks the mention rules or the prompt would outgrow 10 000 chars: then it degrades to literal
  text as for a deleted file). Open file tabs of the thread on screen follow the move (renamed in
  place); tabs remembered on other threads find the file gone and close with a notice that now
  says "moved, renamed or deleted". A draft still mentioning the old path is refused at send with
  "There is no file … in your workspace. Pick it from the list again." (KOBE-223).
- **Web:** flat ARIA tree (`role=tree`, `treeitem` with level/setsize/posinset/expanded), one tab
  stop (roving), arrows, Home/End, Enter, type-ahead, F2 rename, Delete, Shift+F10 / Menu key for
  the row menu; handled keys are prevented so the CE23 shortcuts never see them, modified keys
  pass. 26 px rows, 24 px menu button (WCAG 2.5.8 minimum; was 32 px, KOBE-269 tests updated),
  size hidden under a 15rem container. Folders load lazily; expansion remembered per **team in
  this browser** (localStorage, like the artifact tabs: the chat has no user id client side).
  200 rows per folder, then "Show N more" (and the next server page). Project mounts: lock icon,
  Read-only marker, no Rename/Move/Delete, not draggable. Upload targets the focused folder.
- **Computer drops:** onto a writable folder row (or the top-level row) upload into it; the rail
  zone stands aside there (`data-kobe-drop-folder`; overlay `pointer-events: none`); elsewhere on
  the rail they still go to `uploads/`.
- **Sandbox agent:** after a server tombstone removes a file, now-empty parent folders go (never
  through a symlink, never in `uploads/`, `projects/`, `.kobe/`).

## Open questions (for Chris or the coordinator)

- Expansion is per team per browser, not per user (no user id in the chat client). OK?
- The browser spec (`e2e/browser/tests/files-tree.spec.ts`) is written, not yet run on gate1.
- Departure: a tiny out-of-scope fix to KOBE-276's `eval-cases.db.test.ts` (audit rows ordered
  by random `id`, flaky) in its own commit.

## Evidence (acceptance criteria → test or command output)

- ac-1, ac-4, ac-5, ac-7: `apps/web/components/files/file-tree.test.tsx` (21 tests: lazy load,
  persistence, blocked storage, reveal, icons, project read-only, Show more, server paging, keys,
  type-ahead, F2/Delete/Shift+F10, DnD, refusals, clash, Move to…, Rename, computer drop);
  `rail-files.test.tsx`, `rail-drop-zone.test.tsx` (tree folder drop), `lib/files/tree.test.ts`.
- ac-2: component renders before/after, light and dark, 280×420 px panel: about 7 rows before,
  14 after (`e2e/browser/test-results/kobe-304-component/files-{light,dark}.png`, local only);
  gate1 shots from the browser spec later.
- ac-3: `apps/web/lib/files/icons.test.ts` (40 cases).
- ac-6: the above plus `file-viewer.test.tsx` (unchanged in intent; the breadcrumb steps became
  tree clicks); browser spec pending gate1.
- ac-8: `services/server/src/workspace-move.db.test.ts` (16: rename, folder, manifest order and
  same objects, tombstone reuse and counters, clash, into itself, path rules incl. bidi/ZWSP/NBSP/
  tag/shell/length/`.kobe`, too long, read-only areas and drops, cross-member, silent hold with
  identical answer and kept history, team-wide hold, release purge, rate limit, team header);
  `packages/db/src/workspace-hold-history.db.test.ts`; unit `paths.test.ts`;
  sandbox agent `sync.test.ts` (follows a server move) and `fs.test.ts`.
- ac-9: `workspace-move.db.test.ts` (schedules follow; old-path draft refused clearly),
  `file-viewer.test.tsx` ("an open file's tab follows a rename and a move of its folder"),
  `lib/chat/artifact-tabs.test.ts`.
- Runs (2026-10-17): format, lint, typecheck, hygiene, wording, license OK; unit tests all green
  (web: 13 timing tests flaked under the parallel turbo run, green alone and in a full web run);
  `@kobe/db test:db` 1221 passed; `@kobe/server test:db` 1578 passed after the KOBE-276 fix.

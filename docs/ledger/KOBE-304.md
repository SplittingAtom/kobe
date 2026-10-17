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

## Security review follow-up (2026-10-17)

- **S1–S3 (one root cause):** the sandbox now applies a move as a **local rename**. Each move is
  journalled (`workspace_moves`, 0116 generated + 0117 custom RLS; probe fixture; trimmed after
  7 days; offboarding deletes it). The agent fetches `GET moves?since=&after=` and renames each
  source to its destination before its pull (an awake sandbox is nudged by a `workspace.moved`
  frame via a `mv` bus hint to the replica holding its socket, only if it announced
  `workspace_moves`), and before its restore on wake (last pulled revision saved in
  `.kobe/workspace-sync.json`). Symlink-safe: own areas only, source and parents lstat-checked,
  real parent paths re-checked under the volume's real root right before `rename(2)`; an existing
  destination is refused and logged, the pull then converges as before (conflict copy). Replay is
  idempotent (a gone source is a no-op). A row whose sha256 equals the local base is never
  downloaded; local edits stay newer work and are pushed onto the moved row.
- **Budget:** besides 60 moves/min, a move starts only while the member's last minute of moves is
  under 20 000 files and 20 GiB (429 `rate_limited`).
- **Retry:** a repeat of a move done within the hour answers 200 as it did (not re-audited).
- **Nits:** N1 prune realpath re-check; N3 comment; N5 NFC-equal sibling clash (409); N6 "Rename it
  first" for a moved file whose own name breaks the rules; N7 documented. N8 (no read path for the
  hold copy, as `workspace_files`), N9 (timing) and N10 (delete still answers 409 `legal_hold`)
  stay open for the coordinator.
- **Tests added:** `workspace-move-limits.db.test.ts` (journal, hint, budget, retry, 10 001 files,
  507, lock timeout 503 + Retry-After, 413, malformed JSON, other team, non-ASCII, NFC/NFD,
  `%2e%2e`, rename-first, long schedule prompt), `GET moves` in `workspace-sync.db.test.ts`,
  `moves.test.ts`, `sync.test.ts` (whole-tree rename incl. caches and unsynced edits, file rename,
  destination exists, replay on wake), `agent.wire.test.ts` (capability and hint). ENOSPC: moot
  with renames (no second copy); not simulated.
- **Tripwire test** (`agent.models.test.ts`, untouched): a 1 ms poll racing Pi's start; passes
  alone and in the package run (4/4 and full suite); a load-dependent flake, not KOBE-304.

## Re-review follow-up (2026-10-17)

- **R1:** a restore treats a journalled move whose source is gone and destination present as
  applied (an earlier attempt or process renamed it), so a retried restore keeps the moved edit.
  A renamed file older than its moved row (an upload made while asleep) is kept as a conflict
  copy and the row is downloaded; a newer one is kept and pushed.
- **R2:** rekeyed states are marked `moved` and never shadow the new path's rows; a commit to the
  old path that landed after the move keeps the renamed file, pushed onto the moved row.
- `.kobe/workspace-sync.json` is written with an on-volume check (`assertOnVolume`).
- Tests: `sync.test.ts` (restore retried after a transient download error; upload while asleep
  then moved; a commit racing the move), each failing without its fix.

## Follow-ups (not in KOBE-304)

- **N8:** no read path for `workspace_file_hold_history` (as `workspace_files`): confirm the
  custodian story, or add a hold-admin read.
- **N9:** a held move takes a few ms longer (the hold INSERT); the residual accepted in KOBE-275.
- **N10:** the browser's delete still answers 409 `legal_hold`; make it silent like the move.

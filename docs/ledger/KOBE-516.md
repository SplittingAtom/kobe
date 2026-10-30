# KOBE-516: Workspace change stream carries moves, so open tabs follow a rename or move

- **Status:** done on `group-hardening-3` (not pushed; the group PR carries it)
- **Branch / worktree:** `group-hardening-3` in `../Kobe-g-hardening-3`
- **Depends on:** KOBE-496 (change stream), KOBE-304 (server moves), KOBE-506 (the race)

## Plan

The server says where a file went; the web follows it for every mover; KOBE-506's client-side
move tracking goes.

## Decisions

- **Contract (additive):** `workspaceFileChangeSchema` gains optional `moved_to` (workspace path,
  nullable), only on a row with `sha256: null` (refined). Old events parse unchanged; the server
  omits the field when there is no move. It rides on `file.changed` _and_ on `file.state`, so a
  tab whose stream was down during the move still follows it after the reconnect.
- **Persisted, one migration** (`0183_workspace_files_moved_to`, generated): nullable
  `workspace_files.moved_to`, CHECK `moved_to IS NULL OR (deleted AND 1..1024 bytes)`. Needed
  because a tombstone keeps no `sha256`, so the stream cannot infer a sandbox rename at read time,
  and a hint-only (NOTIFY) move would be lost on reconnect. No RLS change (existing team table).
  Every write of a row resets it (`writeRow` upsert, the move's re-used tombstone upsert); the
  CHECK makes a forgotten reset fail loudly.
- **(a) Move route** (`workspace-sync/move.ts`): the tombstone UPDATE sets `moved_to` to each
  file's own new path (folders: per file).
- **(b) Sandbox rename detection** (`workspace-sync/renames.ts`, called at the end of
  `commitChanges`): the sandbox pushes an agent's `mv` as a put of the new path (`base_rev` null
  or onto a tombstone) plus a delete of the old one, in the same commit (puts and deletes of one
  push share a commit up to `COMMIT_BATCH` = 250 changes). A deleted path is paired with a created
  path when the match is unique both ways: same sha256, and if the content appears more than once,
  the same base name. Anything ambiguous names no move (the tab closes as for a deletion).
  Limits, accepted: a `mv` that is also edited before the push, a rename split across two
  commits (> 250 changes, or the agent's `mv` straddling a push), or several same-name
  same-content files are not attributed.
- **Web:** `components/chat/use-follow-moves.ts` (replaces `use-moving-files.ts`): the panel
  watches every open file tab's path on the page's feed (previews too, not only text tabs) and
  retargets a tab whose change names `moved_to` (`moveFiles`: drafts + tabs). The move route's
  answer still retargets as before (whichever comes first; the second is a no-op).
  `useOutsideChange` no longer re-reads a moved path. The feed remembers moves (`movedTo`, last 256) after the tab left the old path, so a late 404 of the old path follows instead of closing
  (`artifact-panel.tsx` `onGone`).
- **ac-3:** removed `useMovingFiles`, `beginMove`/`endMove`/`isMoving`/`moveRecheck` and the file
  browser's `onMoveStart`/`onMoveFailed`. No optimistic retarget was needed: the stream or the
  answer retargets, and nothing reads the old path in between any more (the stream's "gone" was
  the only trigger).
- **Test determinism:** `file-viewer.test.tsx` now hands the fake change stream the test's own
  workspace (`files = fake.workspaceFiles`), so a reconnect no longer reports every path absent
  (KOBE-506's root of the flake); the fake's `move` says where files went, like the server.

## Open questions (for Chris or the coordinator)

- The migration: the group PR carries it; if another group lands a migration first, run
  `pnpm --filter @kobe/db db:rebase`.
- **Gate check (ac-1 e2e):** new test in `e2e/browser/tests/file-tab-outside-change.spec.ts`,
  "file tab: follows the agent's mv to the new path instead of closing" (a bash `mv` turn). Not
  run here (needs gate1); run it there after deploy.

## Evidence (acceptance criteria → test or command output)

- **ac-1 (agent `mv`):** server `workspace-changes.db.test.ts` "tells open tabs where the agent's
  mv in the sandbox put a file (KOBE-516, ac-1)" (file, folder with duplicate content, unrelated
  put+delete is no move); `workspace-sync/renames.test.ts`; web `file-viewer.test.tsx` "the
  agent's mv in the sandbox: open tabs follow, previews included (KOBE-516, ac-1)"; e2e above.
- **ac-2 (another browser; deletions close):** `workspace-changes.db.test.ts` "tells open tabs
  where a file moved from another tab or device (KOBE-516, ac-2)" (route move, folder move,
  delete has no `moved_to`, catch-up after reconnect, path re-written clears it); web
  `file-viewer.test.tsx` "a move from another browser follows; a deletion still closes the tab";
  `use-outside-change.test.tsx` "a move the stream names is followed by the tab, not read as gone";
  `remote-changes.test.ts` "remembers where a file moved, after its tab followed it".
- **ac-3:** `use-moving-files.ts` deleted; `file-viewer.test.tsx` "a held move: the stream names
  the new path first and the tab follows at once" and "a move that fails leaves the tab where it
  was"; the original "tab follows a rename and a move of its folder" kept.
- Contract: `packages/protocol/src/workspace-changes.test.ts` "carries where a moved file went,
  additively (KOBE-516)".
- The three web KOBE-516 tests fail with `useFollowMoves` disabled (checked).
- `pnpm verify`: build, lint, typecheck, format and every unit suite green (web twice: 309/309
  files). Server `test:db` has ~40 files failing on this branch from KOBE-518, not this ticket:
  `src/testing/run-fixture.ts` and `skill-eval-bench.ts` still send Pi `1.0.0` hellos, now refused
  (`unsupported_version`). The workspace db suites (changes, move, move limits, sync, files) pass.

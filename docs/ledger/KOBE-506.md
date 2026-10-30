# KOBE-506: Flaky file-viewer "tab follows a rename and a move of its folder"

- **Status:** done on `group-hardening-1` (not pushed; the group PR carries it)
- **Cause: component, not only test timing.** The server moves the files before it answers the
  move, and the change stream (KOBE-496) can report the old path as gone (`sha256: null`) first.
  The open tab then reads the old path, gets 404, and `dropFile` closes it with the "no longer in
  your workspace" notice; or the 404 lands after `retargetFiles` but before the commit, so the tab
  follows and the notice still shows (the CI failure). In the test the stream's 300 ms debounced
  reconnect reports every path as absent (its fake workspace is not the test's `files`), so the
  window was hit on a loaded runner.
- **Fix:** `components/chat/use-moving-files.ts`: the file browser announces a move
  (`onMoveStart`/`onMoveFailed`); while it is pending, and until the committed tabs no longer hold
  a file under it, a file tab's read-driven `onGone` (`artifact-panel.tsx`) ignores paths under it.
  Deliberate `dropFile` calls (sync-conflict "Delete the copy") still close the tab. A failed or
  lost move re-reads its tabs, so a file really gone closes as before. Tests in
  `file-viewer.test.tsx` (held move + stream "gone"; failed move with the file still there and
  really gone; Delete the copy during a move) were red before the fix.
- **Known limit (filed separately by the coordinator):** moves by the agent or another device
  still race, because the change stream carries no move; that needs a server-emitted `movedTo`.
- **ac-1:** the original test 20/20 consecutive local runs pass. **ac-2:** the notice no longer
  flashes during a move.
- **Superseded by KOBE-516** (`docs/ledger/KOBE-516.md`): the change stream names `moved_to`, open
  tabs follow it for every mover, and `use-moving-files.ts` is gone.

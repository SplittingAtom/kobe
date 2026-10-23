# KOBE-491: An open file tab notices when the agent changes the file

- **Status:** committed locally (not pushed; coordinator opens the PR)
- **Branch / worktree:** `kobe-491-tab-notices-changes` in `../Kobe-wt491`
- **Depends on:** KOBE-488 (live write signal, merged #379). KOBE-489 (#378) was still open at
  start, so no rebase; this branch does not touch `file-edit-card.tsx`.

## Behaviour (for docs/file-editing.md section 4; the coordinator updates that doc)

An open text tab in the file editor follows outside changes to its file (the agent's `write` /
`edit` synced by the sandbox, or another save).

- **When it checks.** No workspace change push exists (the Files tree re-lists only after a
  wake), so a tab checks on three hints (`components/chat/use-file-change-hint.ts`):
  - the live run's successful `write`/`edit` of that path (the same tool.result signal as the
    KOBE-488 thread badges, via the shared `liveWritePaths`), then again after 1.5, 3, 6, 12 s;
  - a run's end: after 2, 5 and 11 s (the post-run sync lands about 2 s after the run);
  - the window regaining focus or the page becoming visible, at most every 10 s.
    Each schedule stops at the first change found; a new hint replaces the pending schedule.
- **How it checks.** A metadata read: the parent folder's listing (`GET /v1/workspace/files`),
  which carries each synced file's SHA-256 from the database, with no file download and no
  `workspace.file_downloaded` audit row. At most 3 pages. One check in flight per tab
  (`VersionWatch`, `lib/files/outside-change.ts`); a result is dropped if the tab's own version
  moved meanwhile (its save or re-read), so a member's own save never looks like an outside change.
- **No unsaved changes:** the tab re-reads in place (no loading state, same editor). The Raw
  editor applies only the changed middle of the text (`minimalChange`), so the cursor and scroll
  outside the change stay; the scroll top is restored. Status line (role=status):
  "Updated by the agent just now." until the next edit or save.
- **Unsaved changes:** nothing is replaced. Banner (role=alert): "The agent changed this file
  while you were editing. Nothing was replaced." with
  - **Compare:** the proposal review's inline diff (`@codemirror/merge` unified view): the
    member's draft (editable) against the agent's version; Accept keeps the member's text at a
    change, Reject takes the agent's. The result stays the draft.
  - **Keep mine:** dismisses the banner for that version; Save then goes to the conflict path.
  - **Take theirs:** asks "Discard your unsaved changes to X and take the agent's version?", then
    drops the draft and reads the file.
    Once a draft goes away by any route (saved, discarded, reverted), a waiting change is read in.
- **Save after an outside change (409):** instead of the bare notice with "Reload the file", the
  same three choices: "This file changed since you opened it (the agent, or another save), so
  nothing was saved. Keep mine saves your version over it." Keep mine saves at the version the
  member was told about (Compare's read, the banner's, or one read when the save was refused);
  if the file changed again since, that save is refused too and says "The file changed again, so
  nothing was saved…" (never a silent overwrite of either side).
- **Proposal reviews** (`propose_file_edit`) are unchanged: a clean tab under review re-reads and
  the review shows its "changed since the agent proposed this edit" notice.
- **Gone:** a clean tab whose file left the workspace closes as before (the re-read's 404); a tab
  with a draft stays open (Save then reports the conflict).
- **Not covered:** notebooks (`.ipynb`) keep their explicit reload; images, HTML and other
  non-editor tabs are not watched; files over the 1 MB preview cap are read-only and not watched.

## Decisions

- Version source: folder listing instead of `GET /v1/workspace/file` (that streams from S3 and
  writes an audit row per read). No server or protocol change.
- `useSave().save` now returns `"saved" | "conflict" | "error"` (was boolean; only the notebook
  view used the result).
- FakeKobe's workspace listing now lists root files and returns `sha256` per file (matches the
  server).
- The e2e `file-editor.spec.ts` conflict step now uses Take theirs (the old "Reload the file"
  button remains only for proposal reviews and notebooks).

## Review fixes (Sonnet review, second commit)

- Focus hints are one-shot: skipped while a write/run-end schedule is pending, never cancel it.
- `VersionWatch.dispose()` clears pending timers and aborts the in-flight listing (`AbortSignal`
  through `fileVersion` → `FilesApi.list`).
- The outside state keeps its object when kind and SHA are unchanged (no re-render).
- Compare's loading status is `aria-live="polite"` with a label.
- Browser spec adds Keep mine on the banner and the refused-save-then-Keep-mine path.

## Open questions (for Chris or the coordinator)

- docs/file-editing.md section 4: replace the gap note with the Behaviour section above.
- Notebooks could follow outside changes the same way once NotebookView handles a new `text`
  under it (follow-up if wanted).

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/files/file-tab-outside.test.tsx` "picks up the agent's write…"
  (same editor instance, cursor stays on its line, note role=status).
- ac-2: same file, "shows the banner; Compare opens the diff; Take theirs asks first".
- ac-3: same file, "Keep mine dismisses the banner; Save offers the choices…" and "Keep mine never
  saves over a version newer than the one it named"; `file-editor.test.tsx` conflict test.
- ac-4: `apps/web/lib/files/outside-change.test.ts` (one in flight, schedule replaced, stops at
  first change, stale results dropped, page cap); tab test "checks after the run ends and on
  window focus, at most once per focus interval".
- ac-5: unit tests above; browser spec `e2e/browser/tests/file-tab-outside-change.spec.ts`
  (not run against gate1, per the brief).
- `pnpm verify`: see the commit.

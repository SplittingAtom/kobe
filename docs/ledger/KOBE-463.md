# KOBE-463: File editor: render/raw editor, viewed-file chip and inline diff with per-change commit (web)

- **Status:** in review (group branch, no PR yet)
- **Branch / worktree:** `group-15-file-editor` in `../Kobe-wt462`
- **Depends on:** KOBE-462 (save route, `viewing`, `propose_file_edit`; spec
  [docs/specs/file-editor.md](../specs/file-editor.md)).

## Plan

1. Pure parts first: which files edit (`lib/files/editor.ts`), drafts and reviews
   (`lib/files/editor-state.ts`), the viewed file (`lib/chat/viewing.ts`), API calls.
2. Stream: `file.edit_proposed` lands on its tool call (`ToolActivity.fileEdit`).
3. UI: `components/files/file-editor.tsx` (Rendered/Raw, Save, conflict, review),
   `code-editor.tsx` (CodeMirror, lazy), `file-edit-card.tsx`, `chat/viewing-chip.tsx`.
4. Unit tests (happy-dom runs CodeMirror and the merge view) and the gate1 browser spec.

## Decisions

- **Version = SHA-256 of the bytes read.** `GET /v1/workspace/file` carries no version header,
  and the synced copy's version is the content's SHA-256 (FE4), so the editor hashes the full read
  (`crypto.subtle`). No server change. A read cut at the 1 MB cap has no version: read-only.
- **Read-only:** project files and thread uploads (`isReadOnlyPath`, FE2), and cut reads, open in
  Raw with `EditorState.readOnly` and a notice; no Save button.
- **Drafts live in the chat session** (`session.editDrafts`), keyed by path, with the version they
  were based on: a tab switch, a thread switch or re-opening the file never loses them; Save always
  names the draft's base, so a newer read can't silently rebase it. Closing a tab (× or Escape)
  with a draft asks (`window.confirm`); the page asks on unload (`beforeunload`); a move/rename
  carries the draft, a deleted file drops it. Escape inside the editor never closes the tab.
- **Conflict (409):** notice "changed since it was opened … nothing was saved", Reload (asks to
  drop the draft). The member copies their text first if they want it; no merge UI.
- **Viewing chip:** the active file tab while the column shows it (not hidden, sheet open) is
  `session.viewing`; every send (composer Enter, queue, new thread) adds `viewing: {path}`. × holds
  for that file until another file is viewed. Any file tab counts (the server reads text only).
  Edit-and-regenerate send no `viewing` (the original's isn't known to the web).
- **Proposal card** under the `propose_file_edit` call, built only from the server's record: the
  live event (now wired: `ToolActivity.fileEdit`) or `GET /v1/threads/{id}/file-edit-proposals`
  after a reload; a done call with no record says it expired (FE9). Review opens the file and puts
  the proposal under review (`session.fileReviews`, one per file). Read-only (shared) threads show
  the card without Review (only the owner can commit).
- **Review:** `unifiedMergeView({original: file, mergeControls})` with the proposal as the doc.
  Accept keeps a change, Reject restores the original; the doc is always what is committed.
  **Commit all saves what is shown** (open changes count as accepted) at the proposal's
  `base_sha256` (FE10); Discard all writes nothing. Commit is disabled when everything was
  rejected. A file whose version moved on since the proposal shows "can no longer be applied"
  with Discard only; an unsaved draft must be saved or dropped before reviewing.
- **Accessibility:** CodeMirror's default chunk buttons fire on mousedown only; Kobe builds its own
  (`click`, so Enter/Space work, names "Accept this change"/"Reject this change") and a toolbar
  (Previous/Next change, Accept/Reject change at the cursor). Deleted text is struck through, so
  colour never carries the diff alone.
- **Colours:** new tokens `--kobe-diff-added(-bg)` / `--kobe-diff-deleted(-bg)` in `theme.css`,
  defined as the status running/failed colours, so both themes follow; `theme-css.test.ts` checks
  text and marks keep AA on the tints in light and dark.
- **Languages:** markdown, json (+ipynb), python, js/jsx/ts/tsx, yaml from `@codemirror/lang-*`
  (each its own lazy chunk); csv/tsv a small `StreamLanguage` (quoted fields, delimiters, numbers);
  everything else plain text.
- **Lazy loading:** `React.lazy(() => import("./code-editor"))`; the languages are dynamic
  imports inside it. Rendered mode never loads CodeMirror.

## Bundle impact

`next build`: none of the `/threads` page's 10 initial chunks (1.9 MB raw) contains CodeMirror.
Lazy chunks on first Raw/Review: ~295 KB raw (view/state/language/commands) + ~50 KB
(`@codemirror/merge`) + per-language chunks (~40–70 KB each). Initial chat bundle grows only by
the small wrappers (editor shell, card, chip, stores).

## Open questions (for Chris or the coordinator)

- Edit-and-regenerate don't resend `viewing`; fine for v1?
- Commit all commits open (unresolved) changes as accepted. If Chris prefers "only accepted",
  it is a one-line change (reject the open chunks before saving).

## Evidence (acceptance criteria → test or command output)

- **ac-1** Rendered/Raw, Save, conflict, read-only, close guard:
  `components/files/file-editor.test.tsx` ("Rendered and Raw"), `lib/files/editor.test.ts`,
  `lib/files/editor-state.test.ts`, `lib/files/api.test.ts` (save request, 409).
- **ac-2** Viewing chip sent and removable: `file-editor.test.tsx` ("the Viewing chip"),
  `lib/chat/viewing.test.ts`, `lib/chat/file-edits-api.test.ts`.
- **ac-3** Inline diff, per-change accept/reject, Commit all, Discard all, stale proposal, expiry,
  live event: `file-editor.test.tsx` ("reviewing a proposal", "the live stream"),
  `lib/chat/live.test.ts`; colours `app/theme-css.test.ts`.
- **ac-4** Unit tests above; gate1 browser spec `e2e/browser/tests/file-editor.spec.ts` (not run
  here: needs `KOBE_BASE_URL`, `KOBE_USER`, `KOBE_PW`, `KOBE_TEAM=team1`, and a deployment with
  KOBE-462 and this branch; `npx tsc -p e2e/browser` passes).
- Licences: `pnpm licenses:update` (10 `@codemirror/*` packages and their `@lezer/*`, MIT).

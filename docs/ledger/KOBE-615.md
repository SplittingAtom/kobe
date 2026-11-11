# KOBE-615: File editor toolbar, Save As, proposal bubble, run split

- **Status:** ready for review (agent done; not pushed)
- **Branch / worktree:** `kobe-615-file-editor-toolbar` in `../Kobe-wt615` (from main `1ceb0b5a`)
- **Depends on:** none (KOBE-614's Threads panel is separate)

## Plan

Chris's request of 2026-11-11: the file editor fills the artifact column, one toolbar holds its
controls (Save, Save As, Rendered/Raw switch, Run/Interrupt/Start for runnable files), proposals
show a gold-glowing bubble with a review row, inline Accept/Reject become icon buttons, and a `.py`
run splits the editor (code top, output bottom). Spec: `docs/specs/file-editor.md` FE14–FE17.

## Decisions

- **No server change.** Save As uses the FE4 save route without `base_sha256` (KOBE-591's create
  mode: creates, or 409 when a live file is there). Replace reads the target's version from its
  folder's listing (`fileVersion`) and saves at it, so a file that changed again is refused again.
- **Save As opens the copy in the same tab** through the panel's `moveFiles(from, to)` (the tab
  moves like a rename); the original's draft is cleared first (it went into the copy).
- **The switch** is a `button role="switch"` named "Raw" (`aria-checked` = raw); "Rendered" and
  "Raw" beside it are mouse shortcuts (`aria-hidden`). Text artifacts (`artifact-text-view.tsx`)
  keep their Rendered/Raw pressed buttons: out of scope.
- **Overflow:** a container query on the toolbar (`@container/toolbar`, 34rem). Save As and Add code
  cell fold into "More file actions"; Save, the switch, Run and the kernel controls never fold (the
  notebook browser spec clicks Start/Interrupt/Restart directly).
- **Disabled reasons** are the button's `title` (tooltip and accessible description), not a hidden
  span (that duplicated notes like NO_THREAD_NOTE in the text).
- **Gold glow:** fixed tokens `--kobe-glow-gold` / `--kobe-glow-gold-border` in `theme.css` (light
  and both dark blocks), like the tool badge (theming §4.4), so every preset has them; class
  `kobe-glow-gold` in `chat-global.css` breathes, `animation: none` under reduced motion, a
  Highlight border under forced colours.
- **Review row:** Previous/Next, "Change N of M" (the change at the cursor, else the next),
  "Accept current change"/"Reject current change" (visible Accept/Reject), Commit all, Discard all.
  CodeEditor reports `onReview` (controls) and `onCurrent`; the old in-editor review toolbar is gone.
  Inline buttons are DOM icon buttons (Lucide CircleCheck/CircleX paths, `aria-label`/`title`
  "Accept change"/"Reject change", `--kobe-diff-added`/`--kobe-diff-deleted`).
- **Split:** `useSplitter` gained `orientation: "horizontal"` (clientY, Up/Down keys). The share is
  a percentage remembered in `localStorage` (`kobe.fileEditor.split`, try/catch): a per-viewer
  convenience; server-side preferences would have needed a protocol/DB change. The output opens on
  Run or on any new run of the file (the agent's too), stays after it, collapses, and closes until
  the next run. Notebooks keep outputs in cells.
- **Refactor:** `editor-save.tsx` (useDraft/useReview/useSave/SaveNotices, re-exported from
  `file-editor.tsx`), `proposal-review.tsx`, `editor-toolbar.tsx`, `save-as.tsx`, `split-pane.tsx`;
  `python-run.tsx` is now the whole `.py` editor (lazy), `kernel-bar.tsx` returns toolbar actions.

## Open questions (for Chris or the coordinator)

- Browser specs not run here (coordinator after the deploy): `file-editor` (new Save As, glow and
  fill checks), `artifact-editor`, `open-file`, `file-tab-outside-change`, `shared-file-badge`,
  `workspaces`, `notebook`, `viewed-file-guard`, `file-edit-auto-open`.
- No browser spec for the `.py` split yet (needs a kernel run); unit-tested only.
- The notebook toolbar has no Rendered/Raw switch (a notebook has no rendered/raw pair today).

## Evidence (acceptance criteria → test or command output)

- ac-1 fill: `file-tab.tsx` fill container, editor body `flex-1 min-h-0 overflow-auto`, CodeMirror
  `min-h-24 flex-1`; browser check in `file-editor.spec.ts` (editor taller than half the tab).
- ac-2 toolbar/switch/overflow: `components/files/editor-toolbar.test.tsx`.
- ac-3 Save As: `components/files/save-as.test.tsx`, `lib/files/save-as.test.ts`.
- ac-4 glow tokens: `app/glow-gold.test.ts`; bubble in `file-editor.test.tsx`.
- ac-5/ac-6 review row and icons: `file-editor.test.tsx` "reviewing a proposal".
- ac-7/ac-8 Run, kernel controls, split: `components/notebooks/python-run.test.tsx`,
  `notebook-tab.test.tsx`, `notebook-view.test.tsx`.
- ac-9 docs: `docs/specs/file-editor.md` FE14–FE17, `docs/file-editing.md`, `docs/theming.md` §4.4.

## Run on gate1 (2026-11-11, coordinator)

Deployed with KOBE-614 merged in (local-227456d5c577). artifact-editor, file-edit-auto-open,
file-editor, file-tab-outside-change, notebook, open-file, shared-file-badge, viewed-file-guard,
workspaces and thread-file-map: 14 passed. One earlier run had the agent-driven "follows the agent's
mv" test time out; it passed alone and in the full rerun (agent-run flake, not this change).

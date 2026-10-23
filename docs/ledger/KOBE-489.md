# KOBE-489: Proposed file edit card: open the agent's proposed edits automatically

- **Status:** in review (committed on the branch, not pushed)
- **Branch / worktree:** `kobe-489-auto-open-edits` in `../Kobe-wt489`
- **Depends on:** KOBE-463 (proposal card, review), KOBE-484 (live-only rule)

## Plan

- Preference key `auto_open_edits` (boolean, absent = off) in `packages/protocol/src/ui-preferences.ts`;
  the server's `/v1/me/preferences` validates with that schema, so no route change and no migration
  (preferences are a JSON column). Web: `LayoutPreferences.autoOpenEdits`.
- Controller: `#liveFileOpen` generalised to `#liveFileRequest(type, …)`; a live
  `file.edit_proposed` above the run's history seq sets `state.fileEditRequest` (same rule as
  KOBE-484's `fileOpenRequest`).
- Card (`file-edit-card.tsx`): owner-only `Open edits automatically` switch (radix Switch, label,
  Space toggles, chat tokens). On a matching `fileEditRequest` with the switch on it does what Review
  does (`fileReviews.start` + new `panel.autoOpenFile`, which opens and activates the tab without
  taking focus, like agent-created artifacts' `autoOpen`).

## Decisions

- Switch state: the member's choice on this page (`session.autoOpenEdits`, shared by every card) else
  the stored preference; saved through the shell's debounced preferences saver.
- Once per proposal: outcomes are kept per `<run>:<tool call>` in the session store (not module
  state), so remounted cards never reopen one.
- A proposal that arrived while the switch was off is marked skipped: turning the switch on later
  never opens it (only proposals arriving while on do). Nothing is decided until the preferences
  have loaded.
- Unsaved draft for the file: the review is not started (held), the card shows
  "Review when you have saved your changes"; Review stays.
- `autoOpenFile` also un-hides a hidden column (it never shows the narrow-screen sheet, which would
  cover the composer).
- Accept/reject/commit unchanged: auto-open only starts the review.

## Open questions (for Chris or the coordinator)

- The held note lives on the card while its live request is the newest; after a later proposal or a
  reload it is gone (Review is still there).
- `artifact-state.tsx` gained `autoOpenFile` (small, additive); KOBE-488 also edits that file.

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/files/file-edit-auto-open.test.tsx` "the switch" (off by default,
  stores `auto_open_edits`, keyboard, reader sees none); protocol `ui-preferences.test.ts`;
  web `preferences.test.ts`; server `me-preferences.db.test.ts` (stores per member, refuses
  non-boolean) — 24/24 passed against the dev Postgres.
- ac-2: card tests "on: a live proposal opens …once", "a replayed backlog … never opens",
  "a reloaded thread's proposal never opens by itself"; controller tests in
  `thread-controller.test.ts` "live file.edit_proposed (KOBE-489)".
- ac-3: card tests: focus stays in the composer, nothing saved, Commit all is the member's;
  "never opens over unsaved changes" (draft kept, note shown, Review stays).
- ac-4: card test "off: a live proposal opens nothing".
- ac-5: above, plus browser spec `e2e/browser/tests/file-edit-auto-open.spec.ts` (two turns,
  toggles the switch on the card, resets the preference and deletes its folder); not run against
  gate1 here (coordinator runs it after deploy).

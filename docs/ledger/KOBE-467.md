# KOBE-467: File editor: edit and regenerate resend the viewed file

- **Status:** in review (group branch, not pushed)
- **Branch / worktree:** `group-31-viewing-regenerate` in `../Kobe-wt467`
- **Depends on:** KOBE-462/463 (viewed-file context), KOBE-473 (one viewed file per run)

## Decision (coordinator, 2026-10-22; recorded in FE7)

- **Edit** sends the file open now from the composer chip, like a new message (none once the chip
  was removed).
- **Regenerate** (answer button, "Regenerate with", thread menu) sends `viewing_from_entry` = the
  prompt's entry id. The server finds the newest run of that thread whose `user_entry_id` is it,
  reuses its `runs.viewing` path (kept after the run ends) and reads the file's current content.
  No viewing on that run, unknown entry or file gone: nothing is added, the run still goes.
- `viewing` and `viewing_from_entry` together: 400. Only that run carries the file (KOBE-473).

## Tests

- protocol `file-editor.test.ts` (schema), server `file-viewing.db.test.ts` (regenerate re-reads;
  gone/unknown adds nothing; both fields 400), web `file-editor.test.tsx` (edit with/without chip,
  regenerate) and `regenerate-with.test.ts`.

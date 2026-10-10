# KOBE-152: 54f Web download card, gallery prompts and share_file e2e

- **Status:** in review
- **Branch / worktree:** `kobe-152-share-file-card-e2e` in `../Kobe-wt152`
- **Depends on:** KOBE-150 (server), KOBE-151 (file browser, merged as #154)

## Decisions

- **Card:** `FileSlot` is now `FileCard` (`components/chat/file-card.tsx`; `slots.tsx` re-exports the old name). Name, size,
  type, optional description, Download button. Download = `ChatApi.downloadSharedFile` (`GET /v1/files/:id/content`
  with `X-Kobe-Team`) then a blob link (`lib/files/save.ts`, shared with the file browser).
- **Refused / rejected:** a `file.shared` event exists only for accepted shares (refusals are tool errors in the tool
  card). The card's states are download failures: 404 (rejected scan, no longer readable) "no longer available",
  503 "file store unavailable, try again", network error.
- **Gallery:** Document Drafter and Data Analyst call `share_file` after saving a deliverable; generations 2 to 3.
  Both already pass `share_file` through the frozen manifest (asserted in `definitions.test.ts`).
- **e2e** (suite shard, after artifacts): Drafter run writes a file, a second run calls `share_file`; checks
  `file.shared`, the `files` row, Owner download (attachment, nosniff), 404 for a second team member, workspace
  copy deleted via `DELETE /v1/workspace/files` (audited `workspace.file_deleted`), download still 200.
  The second user `reader@e2e.test` is made in SQL with a copy of the Owner's credential hash (sign-up is disabled).
  Not run locally (CI e2e job).

## Open questions

- ac-2 says "volume deleted": the e2e deletes the workspace copy through the browser API, not the PVC.

## Evidence

- ac-1: `components/chat/file-card.test.tsx`. ac-2, ac-3: `e2e/run.sh` section "share_file (KOBE-152)"
  (and `file-share.db.test.ts` "survives losing the workspace").

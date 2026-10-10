# KOBE-194: Composer attachment follow-ups

- **Status:** in review
- **Branch / worktree:** `kobe-194-composer-followups` in `../Kobe-wt194`
- **Depends on:** KOBE-145. Web only, no migration.

## Decisions

- **Chips after reload:** `GET /v1/files/:id` serves only `shared` files and thread entries carry no
  file ids (only Pi's "Attached files:" text with the sandbox path), so uploads are looked up in the
  caller's workspace (`/v1/workspace/files?path=uploads/<thread>`): one listing per thread, not per
  file (`lib/chat/sent-files.ts`). Thumbnails: raster images (png/jpeg/gif/webp, up to 5 MiB)
  fetched with the session through `/v1/workspace/file` and shown as a typed blob URL; no data URLs,
  never SVG. Failures leave the plain name chip.
- **Failed send to a new thread: keep, don't clear.** Thread creation failing leaves the files in
  the `new` draft (retry works). Thread created but message refused: the files move to the new
  thread's draft (`AttachmentStore.move`), so they stay visible and resendable.

## Server follow-ups

- A batch metadata endpoint for uploads (by file id, with `mime_type`/size) and `file_ids` on thread
  entries would avoid path matching; the upload route also has no read endpoint.

## Evidence

- ac-1: `attachments-reload.test.tsx` (size and thumbnail after reload with one listing, SVG
  excluded, lookup failure; both failed-send cases), `uploads.test.ts` (path parsed).

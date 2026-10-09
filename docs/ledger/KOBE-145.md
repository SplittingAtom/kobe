# KOBE-145: 53e Web: composer drag-and-drop attachments

- **Status:** in review
- **Branch / worktree:** `kobe-145-composer-attachments` in `../Kobe-wt145`
- **Depends on:** KOBE-141 (contract), KOBE-143 (upload API), KOBE-144 (submit with `file_ids`)

## Plan

apps/web only, tests first. `lib/chat/uploads.ts` (XHR transport, pre-checks, messages),
`lib/chat/attachments.ts` (per-draft store on `ChatSession`), `components/chat/attachment-chips.tsx`,
composer (paperclip, drop), `file_ids` through `onNew` -> `ThreadController.send` -> `sendMessage`.

## Decisions

- **Own store, not assistant-ui's AttachmentAdapter:** queue/steer bypass assistant-ui's composer,
  and its attachment lifecycle is built for inline content parts, not server-side file ids.
  The store is keyed by thread id (or `new`) and lives on the session.
- **XHR for uploads** (fetch has no upload progress); transport injectable for tests.
- **Limits:** install defaults from `@kobe/protocol` (100 MiB file, 500 MiB message, 100 files) for
  pre-checks only; server errors use their own `limit_bytes`. Error codes mapped to plain text.
- **Send is held** while a file uploads or has failed (remove or retry first). Steer is disabled with
  files (steer has no `file_ids`). Edit/regenerate re-send text only.
- **Chips on sent messages:** pending message from the send; committed message by parsing the
  "Attached files:" list Pi stored (`splitAttachedFiles`), sizes from this tab's sent files only
  (unknown after reload). Thumbnails only for images in the composer and the just-sent message
  (object URL); there is no file download route to fetch from.

## Open questions (for Chris or the coordinator)

- Chips after reload lack sizes and thumbnails; a `files` list on thread entries would fix it.
- If a send to a brand-new thread fails after the thread was created, its draft files stay under `new`.

## Evidence

- ac-1: `attachments.test.tsx` (pick, drop, progress, remove/abort). ac-2: pre-check, scan_rejected,
  retry, `uploads.test.ts`. ac-3: send test (file_ids, chips with name and size), `splitAttachedFiles`.

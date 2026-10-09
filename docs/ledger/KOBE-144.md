# KOBE-144: 53d Message submit with files: sync to workspace and native images

- **Status:** in review
- **Branch / worktree:** `kobe-144-message-with-files` in `../Kobe-wt144`
- **Depends on:** KOBE-141 (contract), KOBE-143 (upload API, `files` rows)

## Plan

No migration. Server: `uploads/attach.ts` (stager) + `attach-list.ts` / `attach-names.ts`, wired into
`submitMessage` and the run start plan. Sandbox agent: `threads/attachments.ts` (confinement, native
images, prompt). Tests first where the harness allowed: `agent.runs.test.ts`, `threads/attachments.test.ts`,
`runs-attachments.db.test.ts`.

## Decisions

- **Three steps around the submit transaction** (no S3 call inside a transaction): `inspect` (short tx:
  own upload, same team, unattached, not in another thread, not scan-rejected, sum <= per-message limit),
  `stage` (object store: copy + workspace blob), `commit` (inside the submit tx: claim rows, quotas,
  `putServerFile`). Failed submit deletes the copies (`discard`); success deletes the old user-tree objects.
- **Errors** (all new `RunError` codes, body `{code, message}`): `file_not_found` 404 (unknown, foreign,
  other-thread, rejected: one answer, no oracle), `file_in_use` 409 (already attached), `message_too_large` 413,
  `quota_exceeded` 403, `storage_unavailable` 503. `attachments_unavailable` 422 now means "no workspace
  storage on this install" (stager not wired, no S3).
- **Coordinator note 2 (retention):** an upload attached at submit is copied from
  `users/<u>/uploads/<id>` to `threads/<thread>/uploads/<id>` (queued in `retention_blob_deletions` first,
  cleared in the commit tx, like 143), `files.blob_ref`/`thread_id` are updated, and the user-tree object is
  deleted after commit. Thread purge and retention then delete it (test "deletes the attached object with the thread").
  A file uploaded with `thread_id` is already in the thread tree (no copy).
- **Workspace write:** content copied (server-side) to the owner's content-addressed blob
  `users/<u>/workspace/<sha>` with the same reservation/blob bookkeeping as a browser upload, then
  `putServerFile(area "user")` at `uploads/<thread>/<name>` in the commit tx, so the manifest row and the run
  commit together; the sandbox pulls it in `beforeRun` (missing attachment fails the run, existing behaviour).
  The workspace is the thread owner's. Workspace and team quotas are checked in the commit tx; the bytes count
  twice toward the team quota (files row + workspace copy), which is what S3 holds.
- **Names:** `attach-names.ts`: first file keeps its name, later same-named files get `-2`, `-3`; assigned in
  attachment order (run created_at, file created_at, id) so a path never changes and a restarted run gets the
  same list. Names the workspace can't hold become `file-<id8>`.
- **Durable attachment list:** `files.run_id` (existing column) marks the run a file was attached to;
  `listRunAttachments` builds `run.start.attachments` from Postgres at start (promotion of queued runs and
  recovery restarts), no new column.
- **Agent confinement (coordinator note 1):** `confineAttachment`: absolute, under the workspace root, no `..`,
  and `realpath(target)` (or deepest existing ancestor) must equal `realpath(root)/rel`: any symlink component
  is refused, dangling too; existing target must be a regular file. Checked at `run.start` (lexical + physical,
  missing allowed), and again after `beforeRun` (files in place; the model can plant symlinks) before reading
  images. Refusal: `pi_rejected`. KOBE-149's `share-path.ts` is not on main yet, so this is a sibling
  implementation of the same rule (comment points at it); fold into one helper after 149 merges.
- **Native media:** the model catalog has no capability flag and adding one is a migration, so the server does
  NOT set `native_media` (absent = path only). The agent honours it: `native_media: "image"` (png/jpeg/gif/webp,
  <= 5 MiB, confined) is sent as Pi `prompt.images` (`{type:"image", data, mimeType}`, Pi 1.0 `RpcCommand`). Pi 1.0's
  RPC `prompt` has no document block, so `pdf` is path-only even if hinted. Media not passed inline gets a note
  in the prompt line ("not shown inline; open it from this path").
- No audit event (the run input and `files` row carry it); add `workspace.upload_attached` if wanted.

## Open questions (for Chris or the coordinator)

- Model capability flag for images (migration on `model_catalog`, e.g. `supports_image_input`) to set
  `native_media` server-side: a follow-up ticket. Until then ac-2 is met on the agent side only.
- Uploaded bytes count twice toward the team quota while attached (upload + workspace copy). Intended?
- Helm values for the upload limits are still missing (from 143).

## Evidence

- ac-1: `runs-attachments.db.test.ts` "syncs the upload into the workspace..." (manifest row, blob, attachment
  frame) and "numbers repeated names and gives a queued run its files".
- ac-2: `agent.runs.test.ts` "passes native images to Pi as image blocks..." (agent side; server side open above).
- ac-3: "refuses unknown, foreign, other-thread and reused files"; "enforces the per-message total".
- Note 1: `agent.runs.test.ts` symlink tests, `threads/attachments.test.ts`.

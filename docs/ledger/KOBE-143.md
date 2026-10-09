# KOBE-143: 53c Upload API (S3-first, limits, per-team quota)

- **Status:** in review
- **Branch / worktree:** `kobe-143-upload-api` in `../Kobe-wt143`
- **Depends on:** KOBE-141 (contract), KOBE-142 (tables)

## Plan

No migration. `POST /v1/uploads` (`routes/uploads.ts`) + `uploads/` service; orphan sweep in the
nightly retention pass; thread export includes files. Tests first: `uploads.db.test.ts`.

## Decisions

- **Streaming:** `busboy` parses multipart as a stream; the file part goes through `UploadMeter`
  (count, SHA-256, first 16 bytes for sniffing, hard stop when over the limit) into the new
  `ObjectStore.putStream` (S3: `@aws-sdk/lib-storage` multipart, 2 x 8 MiB in memory per upload;
  never the whole file). New deps: `busboy` (MIT), `@aws-sdk/lib-storage` (Apache-2.0).
- **Keys:** threaded `teams/<t>/threads/<thread>/uploads/<file>` (inside the thread tree, so the
  retention purge and export already cover it, per KOBE-142); thread-less
  `teams/<t>/users/<u>/uploads/<file>`. (The brief's `teams/<t>/uploads/<thread>/` would be outside
  the thread tree retention deletes.) KOBE-144 note: a file attached at submit keeps its user-tree
  key; its purge on thread deletion needs 144 to copy it into the thread tree (or to extend retention).
- **Limits** (`uploads/settings.ts`, zod, env): `KOBE_UPLOAD_MAX_FILE_BYTES`,
  `KOBE_UPLOAD_MAX_MESSAGE_BYTES` (defaults = contract constants), `KOBE_TEAM_STORAGE_QUOTA_BYTES`
  (install default, 10 GiB), `KOBE_UPLOAD_ORPHAN_HOURS` (24). Not yet in the Helm chart values.
  A single file is cut off mid-stream at min(file, message) limit (`file_too_large`, or
  `message_too_large` when the message limit is the smaller). The per-message sum is submit's job (KOBE-144).
  A Content-Length over limit + 64 KiB multipart slack is refused before reading the body.
- **Quota, atomic:** after the bytes are in S3, one transaction takes
  `pg_advisory_xact_lock(hashtextextended('kobe.storage:<team>'))`, computes usage
  (`SUM(files.size_bytes)` + `SUM(workspace_sync.live_bytes)`) against `team_storage_quotas.max_bytes`
  (null / no row = install default), and inserts the `files` row under the same lock. Uploads of one
  team serialize on that short section, so concurrent uploads cannot jointly pass the limit (test: 6
  racing 800 B uploads, quota 1500, exactly 1 stored). Over quota: object deleted, 403 `quota_exceeded`.
  A cheap pre-check rejects a team already at its limit before streaming. In-flight bytes are not
  reserved, so S3 may briefly hold up to concurrency x file limit of objects that are then deleted.
  Volume sizes are not counted (provisioned per sandbox, not stored by Kobe). Workspace sync's own
  `QuotaCheck` is NOT wired to the team quota here (see open questions).
- **Atomicity of the write:** failed/refused upload leaves no row (row is the last step) and the
  object is deleted. Threaded keys are queued in `retention_blob_deletions` (due in 1 h) before the
  first byte and cleared in the commit transaction, so a crash leaves nothing retention cannot
  delete. Thread-less crash leftovers (object without row) have no such queue (needs a thread id).
- **Sniffing:** `uploads/mime.ts`: signature table (png, jpeg, gif, webp, pdf, zip, gzip), else the
  declared type if well-formed, else `application/octet-stream`; a zip signature keeps a more
  specific declared type (docx etc.). Never rejects.
- **Scan seam:** `UploadScanner` option of `storeUpload` returns none/clean/rejected/unavailable
  (-> 422 / 503, object deleted); default none (`scan: skipped`). KOBE-146 supplies it.
- **Audit:** `workspace.file_uploaded`, `workspace.upload_refused` (reason, bytes seen), `workspace.uploads_expired`
  (system); counts and ids only (docs/audit-log.md).
- **Thread-less lifetime:** 24 h (`KOBE_UPLOAD_ORPHAN_HOURS`, max 720). `expireOrphanUploads` runs as
  a step of the nightly retention pass per team: so a draft file lives 24 h to ~48 h. Skips owners
  under legal hold. Deletes the object inside the transaction holding the legal-hold lock, then rows.
- **Purge / export / hold:** purge via KOBE-142's `blob_ref` registration and cascade; thread export
  streams `files/<id>/<name>`; legal hold via the DB delete guard (tested for the sweep).
- Extra file parts after the first are ignored. A foreign or trashed thread id is a 404
  `thread_not_found`.

## Open questions (for Chris or the coordinator)

- Wire workspace sync's `QuotaCheck` to the same team quota (brief mentions it)? It would need the
  same advisory lock inside the sync commit; left out to keep this PR small.
- Add the four env vars to the Helm chart (`charts/kobe`)? Not done here.

## Evidence

- ac-1: `uploads.db.test.ts` (file_too_large mid-stream and by Content-Length, quota default/own/null,
  workspace bytes, race), `uploads/settings.test.ts`.
- ac-2: `uploads.db.test.ts` (key layout, no row on S3 failure / refusal / scan), `s3.test.ts` putStream.
- ac-3: audit assertions in `uploads.db.test.ts`; "retention and export" and "orphan sweep" tests.

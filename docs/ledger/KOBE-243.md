# KOBE-243: Retention deletes abort on timeout; restore pauses retention

- **Branch / worktree:** `kobe-243-retention-delete-abort` in `../Kobe-wt243`. Depends on KOBE-189. No migration.

## Decisions

- `ObjectStore.delete(keys, {signal})`; S3 passes `abortSignal` per call and rejects with `deleted` (keys confirmed gone).
  `retention/bounded-delete.ts#deleteBounded` aborts on timeout and waits for the store to settle (10 s grace) before
  rejecting with `DeleteAbortedError {deleted, aborted, unsettled}`, so the tx (and the shared legal-hold lock) outlives
  every delete. Used by blobs, orphans, memory, uploads expiry and workspace gc (all had the same race).
  The tx rolls back on a timeout; retries are idempotent (missing keys are fine, queue rows stay).
- `BlobStore.deleteTimeoutMs` (test hook, default 30 s).
- `KOBE_RETENTION_PAUSED` (config, `RetentionJob.tick` returns `paused`, no lock taken) wired by chart `retention.paused`
  on server and scheduler. Runbook step 5 in `docs/backup-restore.md`.
- Removed members: the sweep also lists `teams/<t>/users/` folders (uuid shape) without a membership or workspace row and
  sweeps only their `workspace/incoming/<uuid>` with the same grace, reference and hold checks.

## Review follow-up (#221)

- The pause also gates the offboarding sweep/purge (`OffboardingContext.paused`) and workspace GC
  (`createWorkspaceSync({paused})`, timed and quota kick). Other timers act on row age or ephemeral state (listed in the runbook).
- Offboarding deletes use `deleteBounded`. `DeleteAbortedError.recover` + `withTeamRecovering`: after a timeout that removed
  some objects, a short follow-up tx (hold lock, `legal_hold_covers` re-check) drops the rows of the gone keys (queue rows, memory
  versions/files, orphan uploads, workspace files/blobs). Workspace GC needs none: its rows stay `deleting`.
- `GET /v1/install/retention` returns `paused`; the retention admin page shows a banner.

## Evidence

- `retention/bounded-delete.test.ts`, `orphans.db.test.ts` ("hanging delete": events order abort, settle, release),
  `retention/paused.test.ts`, `charts/kobe/tests/retention-paused.test.ts`.

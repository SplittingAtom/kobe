# KOBE-185: Upload follow-ups (sync counts against the team quota; chart values)

- **Status:** in review
- **Branch / worktree:** `kobe-185-upload-followups` in `../Kobe-wt185`
- **Depends on:** KOBE-143, KOBE-27

## Plan

No migration. Tests first: `workspace-sync-team-quota.db.test.ts`, `charts/kobe/tests/uploads.test.ts`.

## Decisions

- **One quota function:** `teamStorageAllows(tx, team, default, deltaBytes)` in `uploads/quota.ts`
  takes the per-team advisory lock (`kobe.storage:<team>`), then checks used + delta against the
  team limit. Uploads call it with the file size before the `files` insert; sync calls it through
  `withTeamStorage` (`workspace-sync/quota.ts`), which wraps the per-workspace `limitsQuota` (kept),
  with delta = new live bytes - committed `workspace_sync.live_bytes`. The lock is held to the end of
  the commit transaction (state is saved in it), so an upload and a push cannot both pass at the edge.
- A delta of 0 or less is always allowed: a shrinking push or delete works when the team is over.
- Refusal is the existing path: per-change `quota_exceeded`, audit `sandbox.limit_exceeded`
  with limit `workspace_bytes` (no new enum value). KOBE-148's file-browser upload goes through
  `sync.quota`, so it is covered too.
- Enabled by `createWorkspaceSync({teamStorageDefaultBytes})`, wired in `index.ts` from the upload settings.
- Lock order: workspace lock, then team lock (uploads take only the team lock), so no cycle.
- **Chart:** `server.uploads.{maxFileBytes,maxMessageBytes,teamStorageQuotaBytes,orphanHours}` ->
  the four env vars (`kobe.uploadEnv`), schema-validated, defaults equal the code defaults.

## Evidence

- ac-1: `workspace-sync-team-quota.db.test.ts` (over-quota push, shrink allowed, race x5: exactly
  one of upload/push wins); `charts/kobe/tests/uploads.test.ts`.

## KOBE-190 (follow-up, branch `kobe-190-attach-quota-once`)

- `storageUsed` counts `files` rows only while unattached (`run_id IS NULL`); an attached upload is
  synced into the workspace, so its `workspace_sync.live_bytes` copy is what counts. Trade-off: if the
  user deletes the workspace copy the bytes leave the quota while the thread-tree object stays in S3
  until the thread is purged. No migration. Test: `runs-attachments.db.test.ts` "counts an attached upload once".

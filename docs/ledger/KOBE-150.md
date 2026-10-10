# KOBE-150: 54d Server share_file handler, files API and file.shared event

- **Status:** in review
- **Branch / worktree:** `kobe-150-share-file-server` in `../Kobe-wt150`
- **Depends on:** KOBE-147 (contract), KOBE-149 (agent side), KOBE-142 (`files`), KOBE-143 (quota)

## Plan

No migration. `files/share.ts` (service), `sandbox-wire/connection.ts` `#onFileShare`, `routes/files.ts`
(`GET /v1/files/:id`, `/content`), audit `sandbox.file_share_refused`. Tests first: `file-share.db.test.ts`.

## Decisions

- **Gate** (as `artifact.put`, KOBE-129): capability `files` announced by the agent, run leased here and
  active, `share_file` call allowed by this connection's policy check with the same canonical input hash
  (`AllowedArtifactCalls` now binds `share_file` too, `BOUND_TOOLS`). Then, in the database: run active and
  owned by the sandbox's user and thread; `files` unique `(team, tool_call_id)` replay (same run only).
- **Verification, never the sandbox's claim:** `input.path` (strip `/workspace/`) must equal `workspace.path`
  (`path_mismatch`); the live `workspace_files` row of (team, user, path) must exist (`not_found`), not be a
  tombstone and match `rev`, `sha256`, `size` (`not_synced`). The copy source is the manifest's `blob_key`,
  not anything the frame names. Size over min(`FILE_SHARE_MAX_BYTES`, `KOBE_UPLOAD_MAX_FILE_BYTES`): `too_large`.
- **Storage:** server-side copy to `teams/<t>/threads/<th>/shared/<file id>` (the thread tree: retention purge
  and export cover it, KOBE-142/143 note). Deviates from the brief's `users/<u>/shared/` and from
  `WorkspaceSync.shareFile` (user tree, outside purge). Key queued in `retention_blob_deletions` (due 1 h)
  before the copy, cleared in the commit. mime sniffed from the first bytes (`resolveMime`), else octet-stream.
- **Commit** (one tx, team storage lock, KOBE-143 quota): row kind `shared` (user, thread, run, tool call),
  `workspace.file_shared` audit (actor = the user), `file.shared` event with description (skipped at the run
  event cap, like artifacts). Over quota: object deleted, `quota_exceeded`.
- **Refusals audited** as `sandbox.file_share_refused` (reason only; throttled 1 per 5 min per reason and
  user), answered `file.share_result` `{ok:false, error}`. Scan seam (`UploadScanner`) reused, off by default.
- **Download:** `/v1/files/:id[/content]`: only `kind = shared`; readable exactly when the thread is
  (`findThread`: owner, or project members), else 404; rejected scan 404; object missing 503. Content is an
  attachment, `application/octet-stream`, nosniff, no-store. Uploads are not served (private to uploader).
- Wire gets `uploads` settings (limits, default quota) through `createServerDeps`.

## Open questions

- `WorkspaceSync.shareFile` is now unused by the server (kept; user-tree key). Remove in a cleanup?
- Retention legal hold for shared files rides on the `files` delete guard (KOBE-142), tested there.

## Evidence

- ac-1: `file-share.db.test.ts` "copies the workspace object into the thread tree...".
- ac-2: "survives losing the workspace" (manifest row and workspace blob deleted, download still 200).
- ac-3: "refusals" (capability, unallowed / forged input, rev / hash / size / path, too large, quota, other
  run, ended run, replay) and "GET /v1/files" authz; purge in "retention".

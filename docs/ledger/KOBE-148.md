# KOBE-148: 54b Workspace file browser API (list, download, upload, delete)

- **Status:** in review
- **Branch / worktree:** `kobe-148-file-browser-api` in `../Kobe-wt148`
- **Depends on:** KOBE-27 (workspace sync), KOBE-142 (files table, unused here), KOBE-147 (contract, PR #125)

## Plan

Server only, no migration. Routes in `routes/workspace-files.ts`, logic in
`services/server/src/workspace-files/` (`browse`, `upload`, `paths`), mounted in `app.ts`;
`index.ts` passes the workspace sync and the lifecycle waker. Contract: `packages/protocol/src/files.ts`
(copied from `origin/kobe-147-files-contract` with its one-line `index.ts` export, because #125 had
a conflict in `frames.ts`; identical content, so merging #125 first or after is clean).

## Decisions

- **Routes** (all under the session's active team, `team.chat`, mounted at `/v1/workspace`): `GET /files?path=`
  list, `GET /file?path=` download, `POST /files` multipart upload, `DELETE /files?path=`, `POST /wake`.
  The contract's `/v1/threads/{id}/...` was only a suggestion: the workspace is per (team, user), not per thread.
- **Authz:** the owner is `(session team, session user)`, never taken from the request, so no parameter
  names another member's workspace; rows are also matched on `team_id`/`user_id` explicitly (plus RLS).
  Paths are matched against `workspace_files` rows only, never a filesystem; object keys come from the row.
- **List:** immediate children of a folder from the last synced manifest in one grouped query (folders
  implied by deeper paths, folders first). Never wakes. Unknown or emptied folder: 404 (folders exist
  only through files). `source` is always `synced`. Capped at 5000 entries (`x-kobe-truncated: true`).
- **Live listing: not implemented (follow-up).** It needs a new server -> sandbox command (and agent
  side directory read) that the contract does not define; the wire has no existing command to extend.
  `POST /wake` (202, fire-and-forget through `SandboxWaker`, deduped by the lifecycle) wakes the sandbox
  when the panel opens, so the next sync catches up; a follow-up can then add the live merge.
- **Download:** `currentEntry` + `objects.get(blobKey)` streamed; `attachment` with ASCII fallback and
  RFC 5987 name, `application/octet-stream`, `nosniff`, `private, no-store`. Audit `workspace.file_downloaded`
  (`userId`, `bytes`; never names) is written when access is granted, before streaming.
- **Upload:** S3 first like the sandbox blob PUT (reserve, put under the workspace's content-addressed key,
  record blob), then `putServerFile(..., "user")` + audit `workspace.file_uploaded` in one transaction. The
  sandbox pulls it; an edit it made on an older revision becomes a conflict copy on its side (KOBE-27 rule,
  covered by a commit-level test). Never overwrites (`already_exists` for a file, a folder or a file in the way).
  Buffered in memory (Content-Length required, <= min(maxFileBytes, 100 MiB)). `TODO(KOBE-143)`: move to its
  streaming upload pipeline (scan) when merged.
- **Delete:** file or folder (all live files under it, <= 10 000, one transaction): tombstones via
  `deleteServerFile`, audit `workspace.file_deleted` (`userId`, `files`, `bytes`). `uploads/` and `projects/`
  are read-only (403 `read_only`); under any active legal hold on the user or team: 409 `read_only` with a
  message (the contract has no `legal_hold` code), checked after `lockLegalHolds`.
- **Audit events** added in `packages/db/src/audit/events.ts` (no migration; action is text) and `docs/audit-log.md`.
- `WorkspaceSync` now exposes `limits` and `quota` (additive) for the upload.

## Open questions (for Chris or the coordinator)

- Contract has no cursor, so no real paging (5000 cap); a cursor needs a contract PR. Also no `legal_hold` error code.
- Workspace blob collection (KOBE-27 gc) does not consult legal holds; this API refuses deletes under hold, but
  sandbox-side deletes followed by collection still free content. Separate ticket?
- Live listing/download of unsynced files: needs the server -> sandbox command (follow-up ticket).

## Evidence (acceptance criteria -> test)

- ac-1: `workspace-files.db.test.ts` "lists a folder from the synced manifest", "works with no sandbox at all (no wake)",
  `POST /v1/workspace/wake`.
- ac-2: "streams the current version", "serves the newest content after an edit"; upload conflict test
  "keeps a concurrent sandbox edit as a conflict".
- ac-3: delete audit tests, read-only areas, "cannot read/delete a teammate's file", legal hold.

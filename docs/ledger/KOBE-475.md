# KOBE-475: Workspace sync re-uploads content missing from the object store; honest message on read

- **Status:** in review (group branch, not pushed)
- **Branch / worktree:** `group-25-missing-blobs` in `../Kobe-wt475`
- **Depends on:** KOBE-27 (workspace sync), KOBE-148 (file browser), KOBE-268 (file tabs)

## Design

gate1's S3 move (SeaweedFS → MinIO, 2026-10-09) left `workspace_files` rows whose objects are gone.
Content-addressed sync never re-uploads an unchanged hash, so they could never heal.

- **Mark (migration 0171):** `workspace_blobs.lost_at` (+ partial index on lost rows). Set only
  when storage says "no such object" for a live row whose `blob_key` is the workspace's own
  content key (`teams/<t>/users/<u>/workspace/<sha>`): on a read (user `GET /v1/workspace/file`,
  `/v1/workspace/frame`, sandbox `GET file`) or by the repair sweep (prefix listing lacks it **and**
  a confirming read says missing). Never from a row alone; storage errors never mark. Server-owned
  project objects (own keys) are reported `content_missing` but not marked (no sandbox can resend).
- **Tell the sandbox:** new `GET blobs/lost` → `{lost: [sha256…]}` (≤ 1000). `blobs/missing` and
  commits treat lost content as absent (a push naming it uploads it first).
- **Resend (agent):** each push asks `blobs/lost`; for every listed hash, a known path whose file is
  unchanged since sync (size + mtime) and re-hashes to it is uploaded with `PUT blobs/<sha>` — no
  commit, revisions unchanged. Old servers answer 404 → nothing to resend.
- **Heal (server):** `PUT` of lost content: Content-Length must equal the row's `size` (else 422),
  bytes stream through the existing SHA-256/size verifier (mismatch: 422, nothing stored), then
  `lost_at` is cleared. No reservation and no counter change: the blob is already counted (quota
  unchanged for re-uploads). A blob marked while a normal upload ran is healed by that upload.
- **GC / legal hold / backup:** unchanged. Collection selects by reference and grace, not by
  `lost_at`; an unreferenced lost row is collected as before (deleting a missing object is a no-op).
  Nothing here deletes. Backups are pg_dump + objects; the column restores with the schema.
- **Read route:** missing content is 503 `content_missing` (new `WorkspaceFileError` code), storage
  errors 503 `sandbox_unavailable`; `not_found` stays for missing files. Web: the tab stays open and
  shows "The saved copy of X is missing; it will be restored from your sandbox at its next sync."
- **Logs:** ids and counts only (no paths, names or content).
- **Review fixes:** the S3 store treats only `NoSuchKey` as a missing object (a wrong bucket, a bare
  404 or any other error is an error, never "lost"). Lost content is listed, accepted as a resend
  and treated as absent only while a live file references it; a resend whose row was collected
  meanwhile is discarded with collection's own claim-then-delete protocol (kept and counted under
  a legal hold), so no unbilled object is left. The sweep makes one storage call at a time,
  `--pace-ms` apart (default 20), and `--max <workspaces>` bounds a run.

## gate1 repair (after deploy; not done by this ticket)

1. In a server pod: `node dist/cli/workspace-repair.js --dry-run` (counts, exit 1 if missing),
   then `node dist/cli/workspace-repair.js` (optionally `--team-id <uuid> [--user-id <uuid>]`,
   `--max <workspaces>`, `--pace-ms <ms>`).
   Expect `missing: 5, marked: 5` for the owner's workspace. Opening any of the 5 files also
   marks it.
2. The owner's sandbox (new image) resends them at its next push (interval, or after a run; it
   wakes when the Files panel opens). Re-run the dry run: `missing: 0`.

## Decisions

- New endpoint rather than a field on the manifest page: the protocol's schemas are strict, so an
  extra field would break running agents of the previous image.
- 503 (not 404) for `content_missing`: older clients and other 404 handlers treat 404 as "gone".
- The sweep is an operator CLI (`services/server/src/cli/workspace-repair.ts`), not a periodic job:
  a full listing per workspace is too costly to repeat; reads keep detecting afterwards.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/workspace-blob-heal.db.test.ts` (detect on read, list, 422 on wrong
  bytes/size, heal, counters unchanged under a full budget, collection, isolation);
  `services/sandbox-agent/src/workspace/resend.test.ts` (resend unchanged files without commit;
  changed files not resent; old server 404).
- **ac-2** `workspace-files.db.test.ts` / `workspace-frame.db.test.ts` (503 `content_missing`,
  marked; project object not marked); `apps/web/components/files/file-viewer.test.tsx` (tab stays,
  message shown).
- **ac-3** `workspace-blob-heal.db.test.ts` "repair sweep" (dry run, mark, idempotent, counts-only
  logs, team scope). gate1 run pending deploy (steps above).

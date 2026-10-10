# KOBE-236: Fork copies offloaded entry bodies

- **Branch / worktree:** `kobe-236-fork-offloaded-entries` in `../Kobe-wt236`. Depends on [KOBE-163](KOBE-163.md). No migration.

## Decisions

- `forkThread(run, blobs, id, options)` (`threads/fork.ts`) works in three steps: plan (read tx) -> copy each
  offloaded body with `ObjectStore.copy` (S3 server-side copy) -> store thread + entries in one tx. No DB
  transaction is open while blobs are copied. Paths without offloaded entries still use one tx.
- Copy key: `<prefix>teams/<team>/threads/<new>/entries/<sha256(entry_id)>`; the new thread id is chosen up
  front (`createThread` takes an optional `id`), so retries overwrite the same keys. Copies are inside the new
  thread's tree, so its own trash/retention purge deletes them; the source's legal hold only matters for
  deleting, never for reading.
- The store tx re-reads the source (access, trash) after copying; if the rows are not stored (trashed meanwhile,
  error) the copied keys are deleted again.
- `409 entry_offloaded` remains for: no object storage configured, or a `blob_ref` outside the source
  thread's tree (`threadKey`). A missing source object makes the copy throw (500).
- Audit unchanged (`thread.forked`, ids and count only).

## Open questions

- None. A crash between copy and commit leaves unreferenced fork keys (no thread row, no
  `retention_blob_deletions` row). KOBE-189's orphan sweep should also cover them: they are always
  `<prefix>teams/<team>/threads/<id>/entries/<64 hex>` where no `threads` row has that id (see `forkedBlobKey`).

## Evidence

- ac-1: `thread-sharing.db.test.ts` "copies an offloaded entry body into the fork's own tree, so purging the
  source keeps it"; "deletes the copied bodies when the fork cannot be stored".

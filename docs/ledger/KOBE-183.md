# KOBE-183: Workspace blob GC ignores legal holds

- **Status:** in progress
- **Branch / worktree:** `kobe-183-blob-gc-legal-hold` in `../Kobe-wt183`
- **Depends on:** none (KOBE-17 hold API, KOBE-27 gc, KOBE-28 purge). No migration.

## Plan

Make every path that deletes S3 objects or workspace blob rows skip content of a (team, user)
covered by an active hold (user hold, or team-wide hold), under the shared legal-hold lock.

## Decisions

- **gc.ts (`collectBatch`) fixed.** Step 1 (mark `deleting`, purge tombstones) and the merged
  steps 2+3 (object delete, row delete) each run in a team transaction that does
  `SET LOCAL lock_timeout='5s'`, `lockLegalHolds(tx)`, then `isUnderLegalHold(tx, team, user)`.
  Held: nothing is marked, no tombstone is purged, the run for that workspace stops (next run
  looks again). Counters still reconcile (no content deleted).
- **Hold placed after marking:** step 2+3 re-checks under the lock, un-marks the batch
  (`deleting = false`, objects are still there) and deletes nothing. A hold approved while a batch
  deletes waits for it (shared lock held across the S3 delete, bounded by a 30 s timeout, like
  retention/blobs.ts). Objects and rows used to be deleted in separate transactions; a crash
  between them is still safe (rows stay `deleting`, the next run finishes).
- Held owners' rows that were already `deleting` before the hold (crash window) stay marked; they
  are retried when the hold is released.
- `afterMark` in `CollectOptions` is a test seam only. `withTimeout` is now exported from
  `retention/blobs.ts` and reused.
- Sandbox-side deletes (tombstones) release blobs; with the GC skipping held owners the content
  stays (answers the KOBE-148 open question).

## Delete paths checked

| Path                                                                                                                                | Result                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace-sync/gc.ts` collectBatch: blob objects + `workspace_blobs` rows (hourly `collectAll`, quota-pressure `collectWorkspace`) | **Fixed**                                                                                                                                                             |
| `workspace-sync/gc.ts` tombstone purge (`workspace_files` where deleted)                                                            | **Fixed** (skipped for held owners)                                                                                                                                   |
| `workspace-sync/store.ts` `compactTombstones` (row cap, user request path)                                                          | Already fine: deletes tombstone rows only; by CHECK they have no sha256/blob_key, so no content; not a purge job                                                      |
| `offboarding/purge.ts` deleteFiles / deleteBlobs / deleteVolume / finish                                                            | Already correct: every step takes `lockLegalHolds` + `isUnderLegalHold` in its own tx, object delete inside it. Added tests (user hold, team hold, hold during purge) |
| `retention/blobs.ts` `deleteBlobBatchInTx` (queued keys of purged threads)                                                          | Already correct: lock shared + `legal_hold_covers` in the queue query, delete inside the tx                                                                           |
| `retention/purge.ts`, `retention/compaction.ts` (thread/entry rows)                                                                 | Already correct (KOBE-18; lock + `legal_hold_covers`, KH001 triggers)                                                                                                 |
| `files` table deletes (KOBE-148/143)                                                                                                | KH001 trigger `files_legal_hold` (0072); file-browser delete is a tombstone, refused under hold                                                                       |
| `artifacts/put.ts` `discard`, `skills/storage.ts` `discardAttemptBundle`                                                            | n/a: delete only the failed attempt's own never-committed key (unique attempt id), not user content                                                                   |
| `workspace-sync/s3.ts`, `testing/*`                                                                                                 | The delete primitive / test fakes, no policy                                                                                                                          |
| Chart / bucket lifecycle rules                                                                                                      | grep found none                                                                                                                                                       |
| KOBE-143 orphan sweep (PR #134)                                                                                                     | Not on main; re-check that its sweep takes the lock and skips held owners when it merges                                                                              |

## Open questions (for Chris or the coordinator)

- If the 30 s delete timeout fires, the S3 delete may still finish after the transaction rolled
  back and released the lock (ObjectStore has no abort). Same weakness as retention/blobs.ts.
- No DB trigger guards `workspace_blobs` / `workspace_files` deletes (would need a migration).

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/workspace-gc-legal-hold.db.test.ts` (10): held user's blobs, objects and
  tombstones kept while others' go; direct `collectWorkspace`; team-wide hold; released hold
  collects; hold placed while waiting for the lock wins; hold placed after marking keeps objects
  and un-marks; approval waits for a deleting batch; offboarding purge: held vs unheld, team-wide,
  hold during purge.

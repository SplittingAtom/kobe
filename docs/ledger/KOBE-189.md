# KOBE-189: Sweep orphaned staging and fork objects

- **Branch / worktree:** `kobe-189-orphan-object-sweep` in `../Kobe-wt189`. Depends on KOBE-184, KOBE-236. No migration.

## Decisions

- Step 6 of the nightly retention pass (`retention/orphans.ts`), so the pass's advisory lock keeps it to one replica.
  No chart/lifecycle rule (chart untouched; KOBE-195 in flight).
- `ObjectStore.list(prefix, {cursor, limit, delimiter})` added (S3 `ListObjectsV2`; `MemoryObjects` with `age()`).
- Staging: per workspace user (team members + users with workspace rows), only
  `<prefix>teams/<t>/users/<u>/workspace/incoming/<uuid>`. Forks: folders under `<prefix>teams/<t>/threads/` with no
  `threads` row, then only `<id>/entries/<64 hex>`.
- Guards: grace `ORPHAN_GRACE_MS` = 24 h by `LastModified`; keys must match the exact shapes under the prefix; no key any
  `BLOB_REF_COLUMNS` column of the team references or `retention_blob_deletions` holds; no hold (staging: the user's or a
  team-wide hold; fork bodies have no owner: any active hold in the team). Checks and delete run in one team tx holding
  the legal-hold lock shared, 100 keys per tx. At most 1000 deletions per team and sweep; 200 listing pages per listing.
- Logs `orphans swept` with counts only. No audit event (no db/audit registry change).

## Open questions

- A removed member's leftover staging objects are not found (users come from `team_members` and `workspace_files`).
- On a huge install the listing restarts each night (page cap); a persisted cursor can follow if needed.

## Evidence

- ac-1: `retention/orphans.db.test.ts` (old orphan deleted, young/referenced/queued/held kept, other prefixes and
  shapes untouched, cap, pass step); `s3.test.ts` "list".

# KOBE-188: Memory retention, purge and offboarding

- **Status:** in review
- **Branch / worktree:** `kobe-188-memory-retention` in `../Kobe-wt188`
- **Depends on:** KOBE-155 (memory service), KOBE-154 (tables, guards), KOBE-18, KOBE-28, KOBE-183. No migration.

## Plan

User decision 2026-10-09 (option b, see BRIEF): a live file is never purged by retention; superseded
versions and long-deleted files go after the team's window; offboarding purges a departed member's
personal memory; legal hold always wins.

## Decisions

- **Where it runs:** `retention/memory.ts` (`purgeMemory`, `purgeMemoryBatchInTx`), called by the
  nightly pass (`job.ts` step "memory", after thread retention, before compaction; needs object
  storage) and by the offboarding purge (`offboarding/purge.ts`, new step `deleteMemory` before
  `finish`, after the 30 days).
- **Window:** the team's effective period (team period capped by install maximum, grace applied),
  read once per team per pass; forever = nothing. Soft-deleted files: `deleted_at < now - window`.
- **Superseded version** = has a newer version AND the next version is older than the window (the
  Undo history is measured from when a version stopped being current, not from its creation). The
  current version is never purged. Deleted files go whole (versions cascade) before the version step.
- **Hold:** each batch is one team transaction: `lock_timeout 5s`, `lockLegalHolds` (shared), then
  selection with `NOT memory_legal_hold_covers(team, owner)` (personal: user or team hold; project:
  any active hold in the team, as KOBE-154). Objects are deleted inside the transaction (30 s bound),
  so an approval waits for a deleting batch and a hold approved before the lock wins. Offboarding
  also runs its own `guard` (user or team hold) first.
- **Object keys:** only keys equal to `memoryBlobKey(prefix, team, doc, version)` are deleted from
  the bucket (never a stored ref we would not derive); rows go regardless.
- **Offboarding scope:** `scope = 'user'` and `owner_user_id = departed`, deleted or not. Project
  memory is never touched. Without object storage configured the step returns "unavailable" while
  files remain (like the blob step).
- **Audit:** new `retention.memory_purged` (reason retention|offboarding, docs, versions, blobs,
  userId?); counts only, written once per non-empty batch. Documented in `docs/audit-log.md`.
- `Harness` gained `adminUrl` (extra superuser sessions to hold the legal-hold lock in tests).

## Open questions (for Chris or the coordinator)

- Same weakness as retention/blobs.ts: if the 30 s delete bound fires, the S3 delete may finish after
  the transaction rolled back (rows stay, objects gone); only superseded/deleted data is affected.

## Evidence

- ac-1: `services/server/src/memory-retention.db.test.ts` (9): old versions purged / current kept /
  Undo history inside window kept; forever purges nothing; deleted file purged after window, live
  never; held owner and any-hold project memory untouched; team-wide hold; hold approved while the
  sweep waits for the lock wins; approval waits for a deleting batch; offboarding purges the departed
  member's personal memory only (project and others untouched), held member untouched.

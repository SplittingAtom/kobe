# KOBE-426: a restored site's sandboxes rows keep `running`, so the first turn's cold start shows no waking

- **Status:** in progress (group G5, branch `group-5-gates`)
- **Branch / worktree:** `group-5-gates` in `../Kobe-g5`
- **Depends on:** found by KOBE-233's restore shard (CI run 39145480035)

## Plan

`kobe restore` marks every `running` sandboxes row `hibernated` inside its transaction, so the
lifecycle announces the wake (`sandbox.waking`, reason `hibernated`) and creates the missing
sandbox. Unit test on the postlude SQL, db test on a real round-trip, gate4-restore's waking check
stays an ordinary check.

## Decisions

- **The restore, not the lifecycle.** The alternative (the lifecycle asks Kubernetes whether the
  pod exists before trusting `running`) adds a cluster read to every wake and changes the
  reconnect path a restarting pod takes. The restore knows that no sandbox of the backup exists
  where it lands; one UPDATE in its transaction is smaller and touches no runtime path.
- **`hibernated`, not deleting the row.** A wake of a hibernated row creates a sandbox that is
  missing (`SandboxProvider.wakeSandbox`: "created if missing, resumed if hibernated"); the row
  keeps its `pvc` and last activity. `destroyed` (offboarded) rows stay as they are, and so does
  `sandbox_connections` (a stale row is never a live connection: `last_seen_at` is old).
- **Where in the transaction:** after the row counts are verified, before FORCE RLS and the user
  triggers come back (the owner bypasses RLS there, and no trigger fires on the update).

## Product failures found

None.

## Evidence (acceptance criteria → test or command output)

- Round 1 evidence of the failure: "m1's sandbox row after the restore: running" and the next
  turn's `waking=-` in e2e (restore), run 39145480035.
- `packages/cli/src/restore-sql.test.ts`: the postlude has the update, after the counts and before
  FORCE RLS and the triggers, only when `sandboxes` is loaded (passes locally).
- `packages/cli/src/backup-restore.db.test.ts` "restores every awake sandbox as hibernated": a
  running and a destroyed row round-trip as hibernated and destroyed (CI db-core; no local
  pg_dump).
- e2e (restore): `...in a sandbox that wakes for it (sandbox.waking)`: pending the next CI round.

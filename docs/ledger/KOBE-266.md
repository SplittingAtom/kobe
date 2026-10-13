# KOBE-266: Flaky: executor e2e share_file run completes without a file.shared event

- **Status:** in review (PR #270)
- **Branch / worktree:** `kobe-266-policy-deadlock` in `../Kobe-wt266`
- **Depends on:** none. No migration.

## Root cause

Both failing e2e runs (PR #228 run 38267946622 executor shard; PR #258 run 38327242212 suite shard)
logged `policy.check denied on error` with Postgres `40P01 deadlock detected` for `share_file`. No
`policy.check evaluation failed` line preceded it, so evaluation succeeded and the error came from the
approval broker's `#create` (`share_file` is a write: ask-on-write asks for approval). The deny was
fail-closed and correct; the run then finished without the share.

The gate1 Postgres log has the same deadlock with statements (2026-10-13 19:41:47 UTC):

```
Process A waits for ShareLock on transaction B ...  SELECT 1 FROM runs WHERE ... FOR NO KEY UPDATE
Process B waits for ShareLock on transaction A ...  insert into "run_events" (...)
CONTEXT: while locking tuple (14,42) in relation "runs"
```

The two transactions:

1. **Status writer** (approval broker `#create`; also decide, expiry, Stop, sweeps, budget stop):
   `lockThreadRow` = `threads ... FOR UPDATE`, then `lockRunRow` = `runs ... FOR NO KEY UPDATE`.
2. **Run event writer** (the ingest's flush without an entry sync, every `appendRunEventsInTx` caller
   that updated the run first): `UPDATE runs SET sandbox_seq ...` (holds the run row), then
   `INSERT INTO run_events`, whose seq trigger updates the run row again.

Postgres re-checks a row's foreign keys on UPDATE when the old row version was written by the same
transaction (`RI_FKey_fk_upd_check_required`: xmin is the current transaction). So the trigger's
second update of the run row checks `runs (team_id, thread_id) → threads` and takes
`FOR KEY SHARE` on the thread row: the writer's real order is **run → thread**. `FOR KEY SHARE`
conflicts with `FOR UPDATE` only. Writer holds run, waits for thread; status writer holds thread,
waits for run: 40P01, and the broker was the victim.

The KOBE-29 rule "thread before run" was followed by every explicit lock; the implicit FK lock broke it.

## Fix (lock order after the change)

- `lockThreadRow` (runs/store.ts) and `findThread(..., { lock: true })` (threads/repository.ts) take
  `FOR NO KEY UPDATE` instead of `FOR UPDATE`. Every thread locker still excludes every other
  (`NO KEY UPDATE` conflicts with itself, `SHARE` and `UPDATE`), so the D17 per-thread mutex is
  unchanged; the ingest, `mirrorEntriesInTx` and `endRunInTx` already used `FOR NO KEY UPDATE`.
  What changes: FK checks (`FOR KEY SHARE`) on the thread row are no longer blocked by it, so the
  implicit run → thread KEY SHARE can't close a cycle. Nobody updates `threads (team_id, id)`, its
  only key, so no lock path needs `FOR UPDATE` for key changes.
- Resulting order, one for everyone: thread row (`NO KEY UPDATE`) → run row (`NO KEY UPDATE`) →
  approval rows → audit chain lock (last write). FK checks take `KEY SHARE` on thread/run rows,
  which conflicts with neither.
- Untouched: retention's `FOR UPDATE OF t` on trashed threads it deletes (a DELETE needs that lock).

Second line of defence (allowed by the brief): the broker's `#createWithRetry` now retries a 40P01
as it already retried 55P03 (`retryableLockConflict`), at most 3 attempts in total, each retry logged
at warn with the code (`approval create deadlock; retrying`). The whole transaction rolled back, so a
retry re-checks everything; a third failure still throws and the check denies (fail closed). No error
ever becomes an allow.

## Diagnostics (e2e)

`e2e/run.sh` share_file: when no `file.shared` arrives it prints the run's non-delta events
(policy.denied reasons, approval.requested/resolved), its approval rows, its audit rows, the server's
warn/error lines about policy/approval/lock/deadlock and Postgres's own deadlock report (statements).
A new assertion "the policy check was decided, not an error" fails by name when the check errored.

## Evidence

- RED (before the fix): `thread-lock-order.db.test.ts`, both cases `rejected 40P01 deadlock detected`.
- GREEN (after): both pass; the run's events are seq 1, 2 and the status writer gets the run row.
- `approvals/lock-timeout.test.ts`: `retryableLockConflict` names 55P03/40P01 only.
- `pnpm verify`, `@kobe/server test:db`: see PR.

## Decisions

- Root fix in the lock mode, not a retry: the retry alone would hide the cycle and still fail under
  load. Considered and rejected: locking the thread in the ingest's plain flush (more contention on
  every delta batch, and every other appender would need the same).

## Open questions

- `runs/queue-order.ts` takes `FOR UPDATE` on queued run rows (KEY SHARE from run_events FKs could
  conflict the same way); queued runs get events only under the thread lock, so no cycle today.

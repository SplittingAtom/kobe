# KOBE-187: Flaky e2e: gate2 ac-4 break-glass reads under the grant fail once

- **Status:** in review
- **Branch / worktree:** `kobe-187-gate2-breakglass-flake` in `../Kobe-wt187`
- **Depends on:** none

## Plan

Find why `reads=200,200,200` and `audited_reads=3` failed once (PR #140, 2026-10-09 15:42Z).

## Decisions

- Activation is NOT asynchronous: `approveGrant` sets status and `starts_at := now()` in the
  approval's own transaction (trigger in migration 0023); no NOTIFY or timer. A read after the
  approval response sees an active grant. The audit row of a read is written in the read's own
  transaction, before the 200, so a later `/v1/team/audit` read-back cannot be early either.
- The only product path that fails a read after activation without a grant problem is
  `AuditBusyError` (503 `audit_busy`): the audit chain lock was held by another audited
  transaction for 5 s; the read rolls back, nothing audited (documented as safe to retry). That
  fits both failures (reads not 200, only 0..2 audit events) but the failed attempt's log was
  replaced by the rerun, so it is the leading hypothesis, not a proof.
- Fix in `e2e/gate2/client.mjs` (assertions in `gate2.sh` unchanged, no fixed sleeps): wait on the
  grant reading `active` through the API, retry only a 503 `audit_busy` read (bounded 20 s), and
  poll the audit read-back until the reads are there (bounded 20 s). New evidence lines
  `grant_status_seen` and `read_attempts` show if a retry ever happens, so a recurrence is visible.

## Open questions

- If `read_attempts` ever shows `503:audit_busy`, find which transaction holds the audit chain lock
  for over 5 s in gate2 (product issue).

## Evidence

See PR for the repeated gate2 runs.

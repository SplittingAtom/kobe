# KOBE-140: flaky db job

## Status

PR open; 10-run proof below.

## Findings

- Each run has its own `kobe_test_<random>` database (global-setup); files run serially. No cross-file race.
- Retention: when the lock connection fails, `tick()` releases it as broken; pg closes the socket
  without waiting, so the backend and its session advisory lock outlive the tick briefly. The next
  test's `tick()` then saw "busy". Fix: `afterEach` in `retention.db.test.ts` polls `pg_locks` until
  no advisory lock is held.
- Waits: `FakeSandbox.until` / `RunFixture.started|until` default 10 s raised to 25 s (below the 30 s
  test timeout). Only matters when a condition is slow, a never-true one still fails.
- Policy `risk_write` / approvals timeouts of 2026-10-06 not reproduced locally (858 tests pass);
  policy engine in that test has ttl 0 (no cache). Attributed to runner starvation; open if it recurs.

## Evidence

- ac-2: PR #118 run https://github.com/SplittingAtom/kobe/actions/runs/37920137739, db matrix 1-10 all
  passed (8-8.5 min each; matrix since reverted). e2e run 37920142070 passed.

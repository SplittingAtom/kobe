# KOBE-278: two-replica site budget overshoot (covers duplicate KOBE-261)

- **Status:** committed on `group-1-fixes` (ticket group G1; no PR of its own)
- **Branch / worktree:** `group-1-fixes` in `../Kobe-g1`
- **Depends on:** KOBE-120 (shared reservations), KOBE-121 (the test)

## Root cause (ac-1, both tickets)

Both: a real product race, plus test timing in the crash test.

1. **Race (overshoot 850 / 550).** A check counts calls written after the gate read the spend only
   through their settled holds, which last `settleHoldMs` (= the cache TTL) from the settle. The
   gate read the spend at L, cached it for the TTL from the end of the read, then queued the check
   (pool of 4, the site advisory lock shared by every replica). If the check ran at or after
   L + `settleHoldMs`, holds of calls written and settled just after L had already ended while the
   stale spend left them out, so the check admitted on spend that was too low, once per stale
   member. Load stretches the queue, hence CI-only. A slow **settle** is not the cause: until the
   settle runs, `release(true)` keeps the hold 30 s, so a late settle only makes it last longer.
   The SQL functions are not at fault (no migration).
2. **Test timing.** The crash test's 400 ms reservation TTL ran out during 21 sequential checks on
   a loaded machine (healthy admit let through), and fixed sleeps (100 ms, 500 ms) did not wait for
   fire-and-forget `end()`s (leftover hold, "1 to be 0").

## Decisions

- `BudgetGate` (model-gateway): each cached state records when its read began. A check that ends
  `settleHoldMs` or more after that read proves nothing: its hold is ended, the spend is read
  fresh, and the check made once more; if that one is slow too, 503 `budget_unavailable` (fail
  closed). With `settleHoldMs` 0 (no holds) nothing changes.
- Production `settleHoldMs` = cache TTL + `SETTLE_HOLD_SLACK_MS` (2 s), so a queued check is
  usually still proven and the re-check stays rare. A settled call then counts in spend and hold
  for up to ~3 s (conservative near the limit).
- Tests: every `end()` tracked and awaited; expiries waited for on the DB clock (bounded polls);
  the load test runs until the budget is used up plus hold + 2 TTLs (not a fixed 2 s); the crash
  test uses a 3 s TTL and repeats a run that took longer than the TTL instead of asserting on it.
- New deterministic DB test: B reads the spend, its checks are parked; A uses the budget up, its
  rows land and settle late (slow settle), their holds expire; then B's checks run. Before the
  fix 4 late admits, overshoot 450; after, all refused `budget_exhausted`.

## Open questions (for Chris or the coordinator)

- A fully round-trip-free proof would read the spend inside `kobe_reserve_budget` (under the lock);
  that needs a SQL change and was not done.

## Evidence (acceptance criteria → test or command output)

- ac-1: above; deterministic repro `two-replicas-site.db.test.ts` "a check that lands after the
  settled holds ended" fails on the old gate 3/3 (overshoot 450), passes after.
- ac-2 (278) / ac-2 (261): loop against the dev Postgres with 24 CPU burners on the 10-core Mac.
  Before: 10/20 runs failed (1 overshoot 250, 9 crash-test admits); at 14 burners 2/10.
  After: 30/30 green. Unit tests `budget-gate-stale.test.ts` (fake clock) cover the re-check,
  cache-entry age, the fail-closed second slow check and `settleHoldMs` 0. CI: pending (group G1).

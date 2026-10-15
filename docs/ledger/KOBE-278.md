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

## Review of 9d6770d4 (Opus) and follow-up commit

- M1 fixed: elapsed time since the spend read is measured on a monotonic clock (`monotonic`
  option, default `performance.now`); the wall clock only drives cache TTLs and rate buckets.
  Unit test: wall clock stepped back 1.5 s during a slow check still re-checks (fails with
  `Date.now`). No extra safety margin: NTP slew is ~1.5 ms over 3 s.
- M3 fixed: `onRecheck` reports every re-check; index.ts logs it (info; warn on the 503) with
  `replica` (pod hostname), team, `firstMs`/`freshMs`, and sets `kobe.budget.recheck` and
  `kobe.budget.check_ms` on the call's span. The gateway has no metrics/counters, only spans.
  `onError` now logs "budget reservation call failed" (it also covers reserve and fresh-read
  failures).
- M2 **not fixed, needs SQL**. `kobe_settle_budget` can only shorten a hold's expiry; changing
  its amount to the charged cost needs an amount parameter (or reading spend inside
  `kobe_reserve_budget`, which allows H = 0). Re-calling `kobe_reserve_budget` as an upsert would
  refuse with `full` exactly near the limit and adds a site-lock round trip per settle. Numbers:
  a settled call counts twice (spend + its estimate: input + output allowance, default 8,192
  output tokens) for H. H went from TTL (1 s default) to TTL + 2 s = 3 s, so the double count
  triples: at 2 calls/s with ~$0.27 estimates, ~$0.54 -> ~$1.62 counted extra. Member holds are
  capped at 25 % of what is left, so a false `full` needs ~4+ active members or one member near
  the end of the budget; the 402 is then turned into a permanent `budget_stopped` run by the
  server (run-state.ts). Cheapest mitigation without SQL: a smaller `SETTLE_HOLD_SLACK_MS`
  (1 s still covers a ~1 s queued check). Coordinator files the SQL follow-up.
- L3 fixed: an inconclusive admitted healthy check is released before the retry; the first
  attempt is made slow on purpose so the retry runs every time; late admits in the KOBE-278 test
  are released before asserting (no cascade into the crash test).
- L1 (residual, rollout only): the bound needs the settling replica's H >= the checker's. During
  the rollout from main, old pods settle with H = TTL and do not re-check.
- L2 (residual, pre-existing): a ledger row landing more than `SETTLE_TIMEOUT_MS` (30 s) after
  release gets no hold; stale checks miss it. "A slow settle is not the cause" holds up to 30 s.
- Info, not changed: an older in-flight cache load can overwrite a fresh one (safe, `readFrom`
  is per snapshot; may cause extra re-checks); a heartbeat `extend` racing `settle` can re-extend
  a settled hold to the reservation TTL (over-reserves only).

## Open questions (for Chris or the coordinator)

- SQL follow-up (M2): settle with the charged amount, or read the spend inside
  `kobe_reserve_budget` under the lock (benchmark the site-lock hold time).

## Evidence (acceptance criteria → test or command output)

- ac-1: above; deterministic repro `two-replicas-site.db.test.ts` "a check that lands after the
  settled holds ended" fails on the old gate 3/3 (overshoot 450), passes after.
- ac-2 (278) / ac-2 (261): loop against the dev Postgres with 24 CPU burners on the 10-core Mac.
  Before: 10/20 runs failed (1 overshoot 250, 9 crash-test admits); at 14 burners 2/10.
  After: 30/30 green. Unit tests `budget-gate-stale.test.ts` (fake clock) cover the re-check,
  cache-entry age, the fail-closed second slow check and `settleHoldMs` 0. CI: pending (group G1).

# KOBE-121: Two-replica budget test

- **Status:** in review
- **Branch / worktree:** `kobe-121-two-replica-budget-test`, `../Kobe-wt121`
- **Depends on:** KOBE-120 (shared reservations); no migration

## Plan

Test only; fix model-gateway if a real overshoot shows.

## Decisions

- Two DB tests, no production change:
  - `two-replicas.db.test.ts`: two full shims (own pool, gate, sink, listener) on one Postgres, 8 members,
    80 calls in two back-to-back waves against a hard team token budget of 10.5 calls. The fake upstream
    reports exactly what a call reserves, so the ledger total is the measure.
  - `two-replicas-install.db.test.ts`: two gates, an install-wide line across 3 teams, simulated ledger and
    no spend hints (stale caches), so only the settled holds cover the window; a crashed replica's holds
    expire, free the budget and leave no live row.
- e2e: new `replicas` step in `e2e/gate2.sh` (gate2 shard has slack; about 25 s). 30 curls from t2's sandbox
  straight at the two model-gateway pod IPs against a member token budget (scope user, so the 25 % member
  share does not interfere) of baseline + 20 tokens. Fake model: 8 tokens a call; a call reserves 17. Shared
  holds admit two; two unshared gates would admit four (32 > 20 + 8). Asserts ledger = admitted x 8 and
  overshoot <= one call.

## Evidence

- ac-1: DB test 1 (dev Postgres): limit 683, one call 65, admitted 11 of 80, spent 715, overshoot 32 (<= 65).
  DB test 2: limit 2050, one call 100, admitted 21, spent 2100, overshoot 50 (<= 100).
  Mutation check: with per-replica (no) shared reservations test 1 fails (admitted 16, overshoot 357).
- No overshoot beyond one call found; no gateway change.

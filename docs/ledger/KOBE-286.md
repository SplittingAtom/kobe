# KOBE-286: reservation reads spend itself (no stale-cache admits, no settled-hold double count)

- **Status:** committed on `group-1-fixes` (ticket group G1; no PR of its own)
- **Branch / worktree:** `group-1-fixes` in `../Kobe-g1`
- **Depends on:** KOBE-120 (reservation functions), KOBE-278 (two-replica site test, review M2)

## Design chosen: spend read inside `kobe_reserve_budget`

Two options were open (review of KOBE-278, M2): (a) read the spend inside the reservation, or
(b) shrink a settled hold to the call's charged cost. (b) needs a new settle parameter, the
charged cost per call id in the sink, and still depends on cache freshness (holds must outlive
every replica's cache, the KOBE-278 re-check and its 503 stay). (a) is simpler and provable:

- Migration `0097_budget_reserve_reads_spend` replaces `kobe_reserve_budget` (same signature, so
  owner, grants and callers are untouched). A line that carries `period` (`month`/`day`, UTC on
  the DB clock) is judged on the daily counters the `run_usage` trigger keeps: site lines on
  `site_model_spend_daily`, team lines on the team's `model_spend_daily` rows (team policy
  applies), member lines on the member's rows. The caller's `spent` is ignored.
- **Proof.** The spend and the live reservations are read in **one statement** per line, so one
  snapshot. For any call X: its reservation commits before X is forwarded; its ledger row and the
  counters commit together (trigger, same transaction) at w; the gateway deletes the reservation
  only after that commit (settle, s > w). A snapshot taken before w sees the reservation (its
  deletion commits later), one taken after w sees the spend. So X counts at least once, whatever
  the gateway cached, however late the check runs, **provided its reservation is still live at
  w**. Twice only between w and s (the sink's settle right after the write: one pool round trip).
- Where X counts zero times until its row lands (review L1): its reservation expired first, i.e.
  a crashed gateway (the row then never lands either), or heartbeats that failed for a whole
  reservation TTL mid-call. `release(true)` no longer caps the hold at 30 s: it renews it for a
  full reservation TTL (10 min default) and the settle ends it, so a slow or retried sink write no
  longer opens that gap. Cost: a row that never lands (lost write) keeps its hold up to the TTL.
- Locks (review M1): the team and member lines are judged under the team lock alone; the site
  lock is taken afterwards, only for the site lines and the inserts. Order stays team -> site;
  atomic as before, because everything a team/member line reads is written only under that
  team's lock (reservations) or only grows (spend). When several lines are used up, the verdict
  may now name a team/member line before the site line (the 402 is the same).
- Each branch (site, team, member; reservations by scope) has plain predicates, so a generic
  plan still uses the indexes (review L3).
- Malformed lines are refused with 22023 before any lock (review L4): unknown or missing scope or
  unit, unknown period, missing/null/NaN limit, no period and no spent, a non-object line. Before,
  most of these were admitted.
- KOBE-120 rules kept: invoker's rights (no SECURITY DEFINER), `search_path` pinned, team set with
  transaction-local `set_config`, a different team in force refused, sweep unchanged.
- Rollout: a line without `period` (a gateway of the release before) is judged on its own `spent`
  as before, so old pods keep working during the upgrade.
- Mixed rollout (review L2): while old and new gateway pods run together, new pods end holds at
  settle, so old pods (judged on their cached spend) can overshoot within their cache TTL again
  (the KOBE-278 bug); and new pods count old pods' TTL + 2 s settled holds next to the spend
  (false 402 near the limit, M2). Accepted: the window is one rolling update and only matters
  near a limit. Guidance: migrate first (the function stays compatible with old pods), then roll
  the model-gateway in one quick rollout, not during a site near its budget.

## Gateway (ac-3)

- KOBE-278's re-check, its 503 path, the monotonic clock and the re-check logging are removed:
  nothing in the gate depends on cache freshness any more (the cached spend only refuses early).
- The TTL + 2 s settled hold is reverted to none: production passes no `settleHoldMs`, so settle
  deletes the reservation once the row has landed. `release(true)` renews it for a full TTL until
  then (`SETTLE_TIMEOUT_MS` removed).
- `DbReservations` sends each line's `period`. The `onError` log line reads "budget reservation
  call failed" (it also covers reserve failures; review Info).

## Tests

- `packages/db` `budget-reservations-spend.db.test.ts`: member/team/site lines judged on the
  counters, not the caller's spend; a written and settled call counts once; a line without period
  uses its own spend; 10 malformed-line cases refused with 22023 (9 were admitted before).
- `two-replicas-site.db.test.ts` now writes real ledger rows (the counters are site-wide, so each
  test counts from the site's spend at its start), no settle hold (as production):
  - KOBE-121 load test, KOBE-278 step-by-step stale check, crash test: pass. Without migration
    0097: load test overshoot 13550, step-by-step overshoot 450.
  - New near-limit test: 5 members spend 2000 of 2050 (written and settled), then one more call
    must be admitted. On be14d3ac (old function, hold TTL + 2 s): false 402 `budget_exhausted` at
    1800 of 2050.
- `two-replicas.db.test.ts` (full shims) runs without its 10 min settle hold.

## Latency (dev Postgres, `kobe_reserve_budget` + settle per call, 5 lines: site month/day, team month/day, member month; 3 teams x 50 members x 15 days of counters)

Interleaved in one database, old behaviour = lines without `period` (no spend read):

|                        | sequential p50 / p95 | 8 concurrent p50 / p95 |
| ---------------------- | -------------------- | ---------------------- |
| before (no spend read) | 3.7 / 5.8-6.3 ms     | 21-22 / 34-37 ms       |
| after (spend read)     | 4.3-4.4 / 6.1-6.6 ms | 28 / 35-40 ms          |

Server-side execution p50 2.1 -> 2.6 ms. An index on `(team_id, user_id, day)` did not help
measurably, so none was added.

After review M1 (team lines out of the site lock), 8 teams x 200 members x 15 days, one reserver
per team (8 concurrent, contending only on the site lock), 5 lines each:

|                                 | sequential p50 / p95 | 8 teams p50 / p95 | reserves/s |
| ------------------------------- | -------------------- | ----------------- | ---------- |
| 0097 first version (60f84cb4)   | 4.7 / 6.2-6.8 ms     | 31 / 59-68 ms     | ~215       |
| team lines before the site lock | 5.0 / 6.5-7.4 ms     | 16.5 / 18-23 ms   | ~410       |

Server-side execution p50 3.0 -> 3.4 ms (one more statement), and 2.6 ms with
`plan_cache_mode = force_generic_plan` (review L3: no generic-plan blow-up).

## Open questions (for Chris or the coordinator)

- Remaining double count: between a row's commit and its settle (ms). Settling inside the usage
  write's transaction would remove it; not needed now.
- A heartbeat or release `extend` that lands after a settle that only shortened a hold can
  re-extend it (over-reserves only); production settles by deleting, so it is a no-op there.
- Not changed (review Info): the 402 message names the cached line's spend (I6); at UTC midnight
  the gateway clock (`at`) and DB clock (`v_today`) can disagree briefly (I1, I5).

## Evidence

- `@kobe/db` test:db: 45 files green, incl. the cross-team probe suite. model-gateway test (121)
  and test:db (17): green. server test:db: 101 files, 1383 tests green.
- `two-replicas-site.db.test.ts` looped 25x against the dev Postgres with 24 CPU burners on the
  10-core Mac: 25/25 green.

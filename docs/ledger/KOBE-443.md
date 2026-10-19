# KOBE-443: kobe_reserve_budget undercounted live holds (overshoot past a hard budget)

- **Status:** in review (Opus), committed on `hotfix-443-444`, not pushed
- **Branch / worktree:** `hotfix-443-444` in `../Kobe-hf`
- **Depends on:** KOBE-120 (reservation functions), KOBE-286 (spend read in the reservation),
  KOBE-327 (0148, the eval line)

## Root cause

`two-replicas.db.test.ts` failed in PR #317's merge queue (run 39257421172, job db-core):
`limit 683 tokens, one call 65, admitted 12/80, spent 780, overshoot 97` (more than one call).
This was a real product race, not test timing.

`kobe_reserve_budget` counted the live reservations on a shared line as
`sum(least(m.amt, sh.share))`: each member's holds counted at most the member share (25 %) of
what is left. Since KOBE-286 (0097) the spend is read fresh in the same snapshot, so that share
**shrinks while calls are in flight**. Holds that a member took while the share was larger were
then undercounted, so a call was admitted although spend plus the live holds already reached the
limit. The rule dates from KOBE-120 (0085, ported from the in-memory gate). 0097 and 0148 carry it
unchanged: 0148 only added the eval scope, the eval reservations and the `eval` column. KOBE-327
did not cause it.

Interleaving (CI's numbers): at spend 0 (share 170.75), A, B and C hold two calls each, five
others hold one: 11 x 65 = 715, so a 12th is refused. Six calls' rows land and settle (390 spent)
while A, B and C still hold 325. Share = (683 - 390) x 0.25 = 73.25. Counted: 73.25 + 73.25 + 65 =
211.5, and 390 + 211.5 = 601.5 < 683, so a member with no hold is admitted (own 0 + 65 <= 73.25).
True exposure: 780 = 12 calls.

## Decisions

- Custom migration `0149_reserve_full_holds` (`CREATE OR REPLACE`, same signature): every live
  hold counts in full (`sum(m.amt)`), and the share join that is no longer needed goes. Everything
  else is 0148's: invoker's rights (no SECURITY DEFINER), `search_path` pinned, the team set
  transaction-locally and a different team refused, the team lock then the site lock, one snapshot
  per line, the sweep, the eval line. `own_share` still caps a member when it reserves, so the
  change refuses only what the old count wrongly admitted.
- Behaviour change: a **lone** call that holds more than is left (admitted because nobody else held
  anything) now counts in full, so the line is `full` for others until it ends. Before, others
  could still get in under the cap (and overshoot).
- Review H1: a line that is `full` only because of holds must not end other members' runs. On
  `full`, the gate re-reads the member's spend (the cached spend may be stale). If the spend itself
  reached the limit, the answer is 402 `budget_exhausted` (final). Otherwise the line is full of
  calls in flight, which end or expire, so the answer is 429 `too_many_calls_in_flight` with
  Retry-After 2, which the sandbox retries. That is the KOBE-259 promise: overlapping calls wait.
  It also covers the settle window's double count and a crashed replica's holds. Some gate and DB
  tests used to expect 402 for holds-only lines. Several did even before 0149 (user lines had no
  cap), so they now expect 429. New unit tests cover a stale cache (402 after the re-read) and a
  fresh spend still below the limit (429). Gateway-only change, no SQL or wire change.
- `MemoryReservations.inFlight` (gateway, tests and single replica) changed the same way.
- The KOBE-261/278/286 fixes are intact: the spend is read under the lock, `release(true)` extends
  the hold, settle deletes the hold only after the row commits.

## Open questions (for Chris or the coordinator)

- 0149 collides with G10's 0149–0151 (#317). The coordinator runs `db:rebase`.
- If "one member's lone large call cannot block the others" must stay, store each reservation's
  counted amount when it is taken (`least(cost, share_then)`, a new column) and sum that. Not done:
  it needs a schema change, and the full count is the safe default.

## Evidence (acceptance criteria → test or command output)

- RED, then GREEN: `packages/db/src/budget-reservations-full-holds.db.test.ts`. One connection, no
  timing: team, site and eval lines, each `ok` (overshoot) before the migration and `full:0` after.
  KOBE-120 properties: not a definer, pinned search_path, a different team refused (42501).
- Upgrade: `packages/db/src/reserve-full-holds-upgrade.db.test.ts`. On the release before, the
  overshooting call is admitted. After migrating as the owner, the six live holds survive, the app
  role gets `full:0`, and the function is still invoker's rights with a pinned search_path.
- `services/model-gateway/src/reservations-memory.test.ts`: the same case in memory. It fails
  before the change.
- Suites and the two-replica loop: see the final report of this hotfix (`@kobe/db` and
  model-gateway `test:db`; two-replicas tests 10 times with 12 CPU burners).

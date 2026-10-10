# KOBE-120: Shared budget reservations in Postgres

- **Status:** in review (migration PR #199, feature PR on top of it)
- **Branch / worktree:** `kobe-120-migration` (migration) and `kobe-120-feature` (feature), `../Kobe-wt120`
- **Depends on:** KOBE-42 (budget gate); KOBE-121 (two-replica test) follows, not done here

## Plan

Move the model-gateway's in-flight reservations (per-replica memory) into Postgres with an expiry, so
replicas share them. Migration PR first (schema, RLS, probe fixture, SQL functions), feature PR second.

## Decisions

- **Two tables.** `budget_reservations` is a team table (RLS, FK to teams, `team_id` first in PK and
  expiry index) and serves the team and user lines. The install line spans teams, which RLS would hide, so
  `install_budget_reservations` is install-wide with no team or user ids (member key `team:user` only).
- **Atomic reserve, one round trip.** `kobe_reserve_budget(...)` (plpgsql, invoker's rights) takes
  transaction advisory locks (team, then install; fixed order, no deadlock), then sums live reservations and
  inserts. plpgsql takes a new snapshot per statement, so the sums see every reservation committed by an
  earlier lock holder. A single `INSERT ... SELECT` could not do this in READ COMMITTED. Same rules as the
  old in-memory gate (spend + others' reservations >= limit is `full`, per-member share 25 % on shared lines
  is `own_share`); the gate passes its budget lines as JSON.
- **Expiry (ac-1, ac-2).** Every row has `expires_at` (`KOBE_MODEL_GATEWAY_RESERVATION_TTL_MS`, default
  10 min). Every read filters `expires_at > clock_timestamp()`, so an expired row never counts, with or
  without a sweep. A crashed replica's rows therefore free themselves.
- **Settle.** Call ends without a ledger row: `kobe_settle_budget` deletes. With a row on its way: expiry is
  shortened to 30 s (the old settle timeout); the sink's `onWritten` then deletes. One statement each, ids as
  a batch.
- **Sweep.** No separate sweeper: reserve deletes the team's rows (and install rows) expired for over a
  minute, under its locks. The index on `(team_id, expires_at)` keeps it cheap.
- **Team context.** The functions set `kobe.team_id` themselves (same transaction-local setting as
  `withTeam()`) and refuse a different team already in force, so a reserve is one round trip instead of
  `withTeam`'s five. RLS still applies inside (invoker's rights).
- **Fail closed.** A store error on reserve gives 503 `budget_unavailable`. A failed end is logged; the row
  expires by itself.
- **Seam.** `ReservationStore` (`reservations.ts`): `DbReservations` in production, `MemoryReservations`
  (the old logic) as the gate's default for unit tests.
- **Order change in the gate.** The rate-limit token is taken before the reservation check (reserve is now
  async and last); a refused or failed reserve gives the token back.

## Open questions (for Chris or the coordinator)

- A call running longer than the TTL loses its reservation while still running (no heartbeat). 10 min is
  well above the idle timeout; add a heartbeat only if long calls show up.
- `kobe_settle_budget` by call id on the install table has no team check (ids are random UUIDs, the table
  holds no team data). Acceptable?
- Reserving sets the team context inside the function rather than via `withTeam()` (latency). Say if you
  want `withTeam()` on this path anyway (about 3 more round trips).

## Evidence (acceptance criteria -> test or command output)

- **ac-1** crashed replica's reservation expires: `services/model-gateway/src/reservations.db.test.ts`
  ("a crashed replica's reservation expires on its own"); `packages/db/src/budget-reservations.db.test.ts`.
- **ac-2** no reservation outlives its expiry: same tests; the expired row is still in the table when the
  healthy gate is admitted. Sweep: "reserving removes this team's rows long past their expiry".
- Atomicity: db test, 8 connections reserve the last 100 tokens, exactly one succeeds.
- Probe: `budget_reservations` fixture in `probe-fixtures/models.ts` (cross-team probe suite stays green).
- Latency (dev Postgres over the LAN, 100 sequential calls, `--disableConsoleIntercept`): `SELECT 1`
  p50 0.83 ms; reserve p50 3.2 ms (p95 4.1 ms); end p50 2.1 ms (p95 2.9 ms). So reserve adds about 2.3 ms
  over a bare round trip (locks, expiry sweep, sums, insert), end about 1.3 ms. The old in-memory path
  cost ~0. Settle runs after the response, off the call's path.
- Commands: `pnpm verify` green except the cli pg_dump tests (no pg_dump on this Mac); `@kobe/db test:db`
  and `@kobe/model-gateway test:db` green.

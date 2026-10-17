# KOBE-300: CI: speed up the db job (server test:db ~13 min on hosted runners)

- **Status:** done on branch, awaiting the G7 PR's CI run as proof of ac-1; no PR of its own (group G7)
- **Branch / worktree:** `group-7-consoles` in `../Kobe-g7`
- **Depends on:** — (touches only CI, test config and four test files)

## Commits

1. `test`: the server's `*.db.test.ts` files run in parallel (`fileParallelism`, `maxWorkers` from
   `KOBE_DB_TEST_WORKERS`, default 4); the three files that shared the global-setup database get
   their own; `runs-queue-pause` restores its sandbox's `run.stop` responder.
2. `ci`: the `db` job is split into `db-core`, a 2-shard `db-server` matrix and a `db` aggregator;
   every job's timeout is 15 min or less; this ledger.

## Measurements (ac-3)

Local, against the dev Postgres over the LAN (CI's service Postgres is on localhost, so CI ran the
same serial suite in ~12.5 min). Baseline = `main`'s config (one file at a time):

| #   | File (services/server, baseline, serial) | Time   | Slowest test                                                             |
| --- | ---------------------------------------- | ------ | ------------------------------------------------------------------------ |
| 1   | `src/runs-queue-pause.db.test.ts`        | 40.4 s | 22.4 s: a scheduled message queues behind a paused queue                 |
| 2   | `src/thread-compact.db.test.ts`          | 24.2 s | 10.6 s: a lost connection fails the compaction (waits the 10 s deadline) |
| 3   | `src/run-prompt.db.test.ts`              | 24.1 s | 6.8 s: stopped while the sandbox wakes                                   |
| 4   | `src/thread-team-sharing.db.test.ts`     | 18.8 s | 2.1 s                                                                    |
| 5   | `src/workspace-sync-limits.db.test.ts`   | 18.3 s | 7.4 s: commits racing collection                                         |
| 6   | `src/runs.db.test.ts`                    | 18.0 s | 5.4 s: a sandbox that never answers run.start                            |
| 7   | `src/runs-review.db.test.ts`             | 15.8 s | 5.6 s: a budget stop whose sender died                                   |
| 8   | `src/workspace-files.db.test.ts`         | 14.9 s | 0.6 s (46 tests)                                                         |
| 9   | `src/threads.db.test.ts`                 | 14.7 s | 8.3 s: thread_busy when the thread row stays locked (lock timeout)       |
| 10  | `src/project-files.db.test.ts`           | 11.6 s | 7.0 s: 50 members do not multiply the usage                              |

The 112 files' own durations add up to ~540 s; the rest of the 939 s serial wall time was per-file
overhead (worker start, importing the server, creating + migrating + dropping each file's
database: ~1.2 s create+migrate, 0.2–1 s drop over the LAN).

| Run (local)                                                | Wall time       |
| ---------------------------------------------------------- | --------------- |
| server test:db, baseline (serial)                          | **939 s**       |
| server test:db, 4 workers (default)                        | **263 s**       |
| server test:db, 6 workers                                  | 197 s           |
| server shard 1/2, 4 workers (56 files)                     | 120 s           |
| server shard 2/2, 4 workers (56 files)                     | 142 s           |
| every other package's test:db (`--filter='!@kobe/server'`) | 73 s (db: 72 s) |

All 1517 server db tests passed in every run above. Locally `@kobe/cli`'s two backup files fail
because the Mac has no `pg_dump` (environment only; CI installs the PostgreSQL 17 client in
`db-core`); egress-proxy, model-gateway and db passed.

`runs-queue-pause` after the fix: 40 s → 11 s (its "scheduled message" test 22.4 s → 2.5 s, the
next one 10.7 s → 0.5 s).

## Decisions

- **Parallel files, not a template database.** Every server db file already opens its own
  throwaway database (`openHarness`, `EventStreamFixture`/`RunFixture`) except three that used the
  global-setup database (`auth`, `agents/store`, `sandbox/reconcile-lock`); `auth` needs a site with
  no users yet, so it could not share with the others once files run together. Those three now
  create their own database like the rest, and the server's global setup is gone. Everything
  cluster-wide that tests look at is already scoped to the file's database or role
  (`pg_stat_activity ... datname = current_database()` / `usename = <appRole>`, advisory locks are
  per database, listeners use port 0). A template database (migrate once, `CREATE DATABASE ...
TEMPLATE`) would save ~1 s per file, ~30 s per shard in parallel, but needs shared roles (grants
  name the template's app role) and changes `waitForAppSessionsToClose`; not worth it now.
- **Connections:** a file peaks at ~12 connections (sampled `pg_stat_activity` every 200 ms: 4
  workers peaked at ~46 own connections, 6 at ~62). 4 workers per shard stay well inside the
  service Postgres's default `max_connections` 100, so CI needs no Postgres tuning.
- **`isolate: false` not used.** vitest estimated ~11 s saved for the serial run (worker spawn
  only), ~2 s per parallel shard; reusing module state across files (loggers, timers, caches) is not
  worth that.
- **Lock/statement-timeout waits:** the long single tests left (compaction's 10 s command deadline,
  `thread_busy`'s lock timeout, the audit chain lock) wait real deadlines on purpose; shortening
  them would change what they assert, and in parallel they cost wall time only once per worker.
  The one real waste was test isolation: `runs-queue-pause`'s "Pi never confirms the abort" test
  left its sandbox ignoring `run.stop`, and with `stopResendMs: 0` every later `settle()` sweep
  re-sent that stop and waited its 5 s timeout (4 × 5 s in the next test, 2 × 5 s after). It now
  restores the responder in a `finally`.
- **Sharding (ci.yml):** 4 workers on one 4-vCPU hosted runner would take an estimated 4–5 min
  for the server (the 6-worker run used ~400 CPU-seconds on the Mac; hosted vCPUs are slower and
  also run Postgres), plus `db`'s other ~2.5 min of steps: under 10 min but with little margin and
  CPU contention for timing-sensitive tests. Two shards halve that per runner:
  - `db-core`: install, PostgreSQL 17 client, "Migrations match the Drizzle schema", every other
    package's test:db including `@kobe/db`'s RLS catalog check and cross-team probe suite
    (`pnpm test:db --filter='!@kobe/server'`), and the KOBE-69 upgrade path. Unchanged steps.
  - `db-server (1/2)`, `db-server (2/2)`: `pnpm test:db --filter=@kobe/server -- --shard=N/2`, each
    with its own Postgres service and `KOBE_DB_TEST_WORKERS=4` (declared in turbo.json's test:db
    `env`, since turbo's strict env mode drops undeclared variables). No PostgreSQL client: only
    `@kobe/cli` runs pg_dump.
  - `db`: the required check (branch protection and the merge-queue ruleset name `checks`, `db`,
    `images`, `k3d`), now an aggregator like e2e's `k3d`: `needs: [db-core, db-server]`,
    `if: !cancelled()`, passes only when both results are `success`. Branch protection and the
    merge queue keep working without a settings change.
- **Expected CI time:** `db-core` ~4–5 min (setup ~1.5 min, test:db ~1.5 min, upgrade path
  ~1 min); each `db-server` shard ~4 min (setup ~1 min, build ~1 min, tests ~2 min). The `db` check
  completes at the slower of them plus a few seconds: **~5 min**, so timeout-minutes is 15 on every
  db job (ac-2) and the aggregator's is 5.
- If the suite grows past target again: more shards (`shard: [1, 2, 3]` and `--shard=N/3`), or
  raise `KOBE_DB_TEST_WORKERS` (6 workers ran green locally, 197 s).

## Acceptance criteria

- ac-1: pending the G7 PR's CI run (expected ~5 min for the `db` check); every test:db suite still
  runs on every push (server split by file across two shards, nothing skipped).
- ac-2: done (15 for db-core and db-server, 5 for the aggregator).
- ac-3: done (table above).

## Checks run

`pnpm format:check`, eslint on the changed files, `@kobe/server` typecheck, actionlint 1.7.7 on
ci.yml, `scripts/check-public-hygiene.sh`; server test:db (full, both shards, 4 and 6 workers) and
every other package's test:db, timings above.

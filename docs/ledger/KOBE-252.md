# KOBE-252: Scheduler: index the latest schedule.skip lookup (KOBE-180 dedupe)

- **Status:** committed on `group-1-fixes` (group G1), not pushed
- **Branch / worktree:** `group-1-fixes` in `../Kobe-g1`
- **Depends on:** KOBE-180 (skip dedupe, schedule offboarding), KOBE-174 (runner), 0087

## Plan

- ac-1: index the latest fire/skip lookup (`scheduler/fire.ts` latestEvent), CONCURRENTLY-ready
  like 0087; EXPLAIN before/after on a large synthetic table.
- ac-2: recover a failed deactivation step (`routes/team.ts:45`) and test it.
- ac-3: system cancels no longer recorded as `user_cancelled`.

## Decisions

- **The index is keyed on a typed `events.schedule_id`, not `lower(ref->>'schedule_id')`.**
  Built as specified first, the expression index was never matched on the schedule key by the app
  role: under FORCE RLS only LEAKPROOF quals become index conditions (as KOBE-33 found for text
  search), and `->>` / `lower()` are not. The plan had `Index Cond: team_id` only and
  `Filter: lower(...)`; on 1M rows the planner preferred a parallel seq scan (205 ms, below).
  uuid equality is leakproof, so a nullable `schedule_id uuid` column (ADD COLUMN without default:
  catalog only) and `events_schedule_latest_idx (team_id, schedule_id, created_at DESC) WHERE kind
IN ('schedule.fire','schedule.skip')` serve it. The three writers in `fire.ts` set the column;
  `ref.schedule_id` stays for readers. No backfill (it would rewrite every fire/skip row in the
  migration's transaction); a schedule mid-streak at upgrade records one more skip, nothing else.
- **Migration 0098 is hand-written** (`-- kobe:hand-written`): both statements need IF NOT EXISTS
  so a large site can add the column and build the index CONCURRENTLY before upgrading
  (`docs/install.md`, Upgrading). db:rebase keeps it and renumbers it; note `migration-plan.mjs`
  refuses a branch that mixes hand-written and generated migrations, so a later G1 ticket with a
  generated migration has to land separately.
- **Query shape:** the kind list is the index's literal `IN (...)` (`sql.raw`), not drizzle's
  `inArray` (bound parameters), so the partial predicate is provable in generic plans too. The
  `due_at` tie-break stays; it is an Incremental Sort over the rows of one `created_at`.
- **What "deactivation" covers (ac-2).** Two paths stop a user's schedules (KOBE-180), each in two
  steps, pause schedules then cancel in-flight scheduled runs:
  - team removal (`DELETE /v1/team/members/:id`): the pause commits with the removal
    (`removeMember` -> `pauseOwnerSchedulesInTx`); the cancel at `routes/team.ts:45` was best
    effort, only logged. The later sandbox offboarding has its own sweep; the cancel had none.
  - user deactivation: the `schedules` lifecycle hook (`stopUserSchedules`) pauses and cancels per
    team; a failure is reported as an incomplete step and never retried.
    Left undone, a run kept working for a gone owner, and a still-active schedule would fire again
    after a reactivation (against the 2026-10-09 decision that only the owner resumes).
- **Recovery is a scheduler sweep, not an inline retry** (`scheduler/owner-sweep.ts`): every tick,
  after firing, per team, owners who are deactivated or no longer members but still have an active
  (or team-admin-paused) schedule or an in-flight scheduled run get both steps again as the
  system: the pause (re-checking `principalActive` under its share lock, so a returning user is
  left alone) and `cancelScheduledRuns` (`owner_deactivated` / `member_removed`). Idempotent; a
  failure for one owner is logged (not counted in `TickResult.failed`) and the next tick retries.
  An inline retry would still lose the step if the process died; the sweep also covers that.
- **ac-3: new transition cause `system_cancelled`** in `@kobe/protocol` (`RUN_TRANSITION_CAUSES`,
  allowed into `cancelled` from queued/running/waiting_approval), used by `cancelScheduledRuns`.
  Compatible: the cause only reaches the server's transition listeners (`RunTransition`) and the
  approval expiry mapping (`system_cancelled` -> `run_cancelled`, the same card text). Clients are
  unchanged: the run event stays `run.interrupted { reason: "cancelled" }`, so old and new web
  render "Stopped". Not adding a field to that payload on purpose: it is a `strictObject`, so an
  old client would reject the event. The web never reads transition causes (checked:
  `apps/web` has no `RunTransition` / cause use); notifications key on the status (`cancelled`
  never notifies). Audit already said `actor: system` with the reason.
- The sandbox `run.stop` frame keeps `reason: "user_cancelled"` for every abort: the field is open
  and informational, the agent ignores it, and the durable re-send (`runs.stop_mode`) has no
  reason to carry.

## Open questions (for Chris or the coordinator)

- The key deviates from the ticket's `lower(ref->>'schedule_id')` for the RLS reason above.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `packages/db/src/schedule-latest-index.db.test.ts`: index definition; as the app role in
  `withTeam()` (RLS on), 2 x 4000 seeded events, ANALYZE, the only `events` scan is
  `events_schedule_latest_idx`, with values and as a prepared generic plan; finds the latest row.
  `scheduler/runner.db.test.ts` checks fires and skips carry `schedule_id`. The drizzle statement
  latestEvent sends, as a generic plan:
  `Index Scan using events_schedule_latest_idx ... Index Cond: ((team_id = $1) AND (schedule_id = $2))`.
  EXPLAIN (ANALYZE, BUFFERS) on the dev Postgres, app role, 1,000,000 events in one team (25 %
  fires, 25 % skips over 500 schedules; the looked-up schedule's only event is the oldest row):

  | query                                       | plan                                         | time     |
  | ------------------------------------------- | -------------------------------------------- | -------- |
  | before: `ref->>'schedule_id' = $2`          | Parallel Seq Scan, 1M rows filtered          | 94.3 ms  |
  | spec: `lower(ref->>...)` + expression index | Parallel Seq Scan (index unusable under RLS) | 205.4 ms |
  | after: `schedule_id = $2` + new index       | Index Scan, Index Cond team_id + schedule_id | 0.079 ms |

- **ac-2** `schedule-governance.db.test.ts` "a failed deactivation step is finished by the
  scheduler's sweep": a removal whose cancel throws leaves the run `running`; the next tick
  cancels it (audit `member_removed`, system), a further tick does nothing. A deactivation without
  its hooks: the next tick pauses the schedule (`paused_by=deactivation`, audited) and cancels the
  run (`owner_deactivated`).
- **ac-3** same describe: the swept cancels report `system_cancelled`; a user's Stop of a scheduled
  run still reports `user_cancelled`. `packages/protocol` `runs.test.ts` covers the table.
- Checks: `pnpm verify` format/lint/typecheck/unit green except three `@kobe/web` timing tests
  under turbo load (127/127 files pass alone). `@kobe/db test:db` 46 files / 1118 tests incl.
  probes; `@kobe/server test:db` 104 files green (after a rebuild). `@kobe/cli` pg_dump tests
  fail as known; `license:check` fails on unchanged main too (environment).

# KOBE-174: 64d Scheduler runner (leased exactly-once firing across replicas)

- **Status:** in review
- **Branch / worktree:** `kobe-174-scheduler-runner` in `../Kobe-wt174`
- **Depends on:** KOBE-172 (table, fire index), 173 (API, recurrence engine). Hooks for 178/179. No migration.

## Plan

Tests first (`scheduler/plan.test.ts`, `scheduler/runner.db.test.ts` with three server deps on one DB, fixed
clock), then `services/server/src/scheduler/{plan,fire,runner,run-hook,process-deps}.ts`, a small seam in the
run orchestrator, `index.ts` wiring, chart values/env.

## Design (dependants must follow)

- **Lease = the schedule row lock.** Per team (`withTeam`, due index `(team_id, next_due_at)`) a tick reads due
  schedules without a lock. Each is fired in ONE short transaction, the orchestrator's own submit transaction:
  `ScheduledSubmit.before(tx)` takes `SELECT ... FOR UPDATE SKIP LOCKED` on the schedule, re-checks it, inserts the
  `schedule.fire` event with `ON CONFLICT DO NOTHING` (the KOBE-172 `events_schedule_fire_uniq` is the final guard),
  creates the thread (`schedule_id` set, Scheduled folder) and advances `next_due_at`; the orchestrator inserts the run;
  `after(tx)` sets `last_run_id` and the event's `run_id`. One commit. A replica that dies mid-way rolls back and
  Postgres drops its lock with the connection, so nothing is lost or half-done and the next tick fires it.
  No lease column, no timeout to tune. Sandbox dispatch happens after the commit; no transaction spans it.
- Row locked by another replica: `busy`, changes nothing. Schedule edited since the scan (prompt, agent, due time,
  active): `stale`, changes nothing; the next tick sees it again.
- **Fire-time checks** (inside the same transaction): schedule active, user active and a team member
  (`principalActive`), agent pin usable (`resolveAgentPin` as the owner: visible, active, published). Failures consume
  the occurrence: `next_due_at` moves on and a `schedule.skip` event (`user_inactive`, `agent_unavailable`) is
  recorded, in a second short transaction (conditional on the scanned due time, so it is idempotent).
- **Catch-up (coordinator rule):** at most ONE fire, the latest occurrence inside the grace window
  (`planFire`); older ones are skipped. `schedule.skip` reasons: `collapsed` (fired a later one, same transaction),
  `missed` (nothing inside the window), `duplicate` (the unique index said it already fired, e.g. resume re-armed an
  occurrence). `next_due_at` becomes the first occurrence after now. Grace window default 60 min
  (`KOBE_SCHEDULER_GRACE_MINUTES`, chart `scheduler.catchUpGraceMinutes`): the contract names none, my choice.
- **Budget-blocked** (ac-2): the run is inserted and failed in the same transaction (`run.failed`,
  new code `budget_exhausted`), the thread and fire event exist (`ref.outcome=budget_blocked`), `next_due_at` advanced:
  visible once, no retry.
- **Scheduled runs are always `auto`:** the run gets `approval_mode=auto` (clamped by the install floor), and
  `resolveForStart` no longer lets the agent version's own stricter mode override it for `trigger=schedule`
  (a run nobody can approve must not wait). Behaviour change in `runs/lifecycle.ts`; user runs unchanged.
- **Process:** the scheduler now builds `createServerDeps` (router, orchestrator) with in-memory stand-in auth
  values and a mailer that refuses (`scheduler/process-deps.ts`), the sandbox provider and lifecycle waker. It serves
  health only (no user API), and runs none of the server's jobs (retention, budgets, audit sweeps, reconcilers,
  hibernation, evals, workspace sync). No sandbox config: the runner stays off and logs an error.
- **Chart:** `scheduler.tickSeconds` (15), `scheduler.catchUpGraceMinutes` (60), `replicas` already allowed > 1.
  Env: `KOBE_SANDBOX_CONFIG` and the four session keys via new `kobe.sandboxSessionEnv` (server's
  `kobe.sandboxEnv` = that + approval key). The scheduler gets NO approval key, auth secrets or provider/virtual keys.

## Hook for 178 / 179

`onScheduledRunEnded(runs, listener)` (`scheduler/run-hook.ts`): once per terminal transition of a `trigger=schedule`
run, on the process that applied it (a server replica for wire-ended runs, the scheduler for the budget-blocked
failure). index.ts subscribes a debug log in both. 179 should insert idempotently (unique per run and kind).

## Open questions (Chris / coordinator)

- Privilege change: the scheduler now holds the four session keys (incl. `model-gateway`, which mints run tokens) so
  it can start sandboxes. Two chart tests asserting it held none were updated to "same keys as the server, no approval
  key". Alternative: leave dispatch to a server replica's stalled-queue sweep (slower, about 30-45 s).
- Grace 60 min and tick 15 s are my choices. Nothing sets `paused_by=deactivation` yet (a deactivated user's
  schedules are skipped and keep advancing; KOBE-180).
- Every skipped occurrence of a still-deactivated user writes one `schedule.skip` event per occurrence.

## Evidence

- ac-1: `runner.db.test.ts` "12 due schedules ... none duplicated" (3 deps/pools), "an instance that dies mid-fire",
  "skips a schedule another instance holds", "unique index stops a second fire".
- ac-2: same file, run gate tests (trigger, approval_mode auto, schedule_id, budget-blocked failed run, one thread).
- ac-3: catch-up tests (collapsed, missed), deactivated user / suspended agent / paused / left team.
- ac-4: `charts/kobe/tests/scheduler.test.ts` (replicas=3, env, ranges), `helm lint`, whole chart suite green.

# KOBE-172: 64b Migration: schedules table, fire dedup index, threads.schedule_id

- **Status:** in review
- **Branch / worktree:** `kobe-172-schedules-migration` in `../Kobe-wt172`
- **Depends on:** KOBE-171 (contract). Blocks 173-176.

## Plan

Migration-only: schema, migrations 0086 (generated) and 0087 (custom RLS + FK), probe fixture, tests first
(`packages/db/src/schedules.db.test.ts`).

## Decisions (dependants must follow)

- `schedules` (team table, PK `(team_id, id)`): columns follow `scheduleResponseSchema`; extra `cron` (derived,
  nullable text). `agent_id` and `last_run_id` have no FK (agents span two tables; runs are purged).
  `notify_email` DB default true (brief); the create body default is false, so the server must always set it.
- `paused_by` null | team_admin | deactivation, only while inactive (check). `user_id` FK users (no action).
- Fire dedup: SQL-only partial unique index `events_schedule_fire_uniq` (IF NOT EXISTS; large installs prebuild it
  CONCURRENTLY, docs/install.md) on `events (team_id, lower(ref->>'schedule_id'), due_at)` where `kind = 'schedule.fire'`,
  plus check `events_schedule_fire_keys` (a fire needs schedule_id and due_at, so NULLs cannot dodge the index). No fires table. The runner inserts the event and treats 23505 as "already fired".
- `threads.schedule_id` nullable, FK `(team_id, schedule_id)` ON DELETE SET NULL (schedule_id) (SQL-only, 0087;
  needs PostgreSQL 15+), partial index `threads_schedule_idx`. Covered by the existing threads policy.
- Indexes: `schedules_due_idx` (team_id, next_due_at where active), `schedules_user_idx`, `schedules_agent_idx`.
- Cap trigger NOT added: the contract counts active schedules across ALL a user's teams, which RLS hides from a
  trigger in the app role; the server enforces it (173). Open question below.

## Open questions

- A cross-team DB backstop for the cap would need a SECURITY DEFINER function plus a cap table outside RLS; say if wanted.

## Evidence

- ac-1: probe fixture `schedules`; `schedules.db.test.ts` isolation test; probe suite green.
- ac-2: `schedules.db.test.ts` duplicate-fire and threads.schedule_id tests.
- ac-3: `drizzle-kit check`, journal test, `pnpm verify`; no app code.

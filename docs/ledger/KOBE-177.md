# KOBE-177: 65b Migration: notifications, email outbox, skipped actions

- **Status:** in review
- **Branch / worktree:** `kobe-177-notifications-migration` in `../Kobe-wt177`
- **Depends on:** KOBE-172, KOBE-176. Blocks 178-181.

## Plan

Migration-only: `schema/schedule-notifications.ts`, migrations 0088 (generated) and 0089 (custom RLS), probe
fixtures in `probe-fixtures/schedules.ts`, tables registered in `tenancy/schedules.ts`. Tests first
(`packages/db/src/schedule-notifications.db.test.ts`).

## Decisions (dependants must follow)

- `notifications` (PK `(team_id, id)`): per KOBE-176 contract; checks pin kind, and the shape (`schedule.paused` has
  no thread/run and a `paused_by`; all others have thread and run, no `paused_by`). Unique `(team_id, run_id, kind)`
  where run_id is set, so an at-least-once notifier inserts once (23505 = already emitted).
- `notification_emails`: new outbox (the existing `budget_alert_emails` / `egress_request_notifications` are bound to
  their own parents, so not reused); same shape plus `lease_until`. One per notification. Status text + check.
- `run_skipped_actions`: PK `(team_id, run_id, tool_call_id)`; `tool`, `risk_class`, `reason` (code pattern).
- Purge: FKs `ON DELETE CASCADE` to threads, runs and schedules (notifications), notifications (emails), runs
  (skipped). Thread/run deletes are already guarded by the legal-hold triggers (0033), so a hold keeps these rows
  too; no new guard. Tested.
- Indexes lead with `team_id`. All new tables, so no IF NOT EXISTS / CONCURRENTLY upgrade note is needed.

## Evidence

- ac-1: probe suite green with the three fixtures; isolation and CHECK tests in `schedule-notifications.db.test.ts`.
- ac-2: same file, "removal with the thread" (cascade, and legal hold blocks with KH001).
- ac-3: journal test, `drizzle-kit check`, `pnpm verify`; no app code.

# KOBE-176: 65a Scheduled-run contract (notifications, skipped actions, pause)

- **Status:** in review
- **Branch / worktree:** `kobe-176-scheduled-run-contract` in `../Kobe-wt176`
- **Depends on:** KOBE-171 (merged). Blocks KOBE-177 (migration), 178 (deny-don't-wait), 179 (notifications), 180 (lifecycle), 181 (web). Spec D32.

## Plan

`packages/protocol` only, additive, tests first. New `notifications.ts` (one index line) plus one
optional field on three terminal events in `events.ts`.

## Decisions (dependants must follow)

- Approval mode: nothing new. `auto` is the existing `APPROVAL_MODES` member; scheduled runs use it via
  `Actor.kind='schedule'`. No parallel enum.
- Skipped action (`skippedActionSchema`, strict): `{tool_call_id, tool (name only), risk (riskClassSchema),
reason_code (policyReasonCodeSchema)}`. Never input, output or message text. Reason is normally
  `scheduled_run_no_prompt`; `mode_auto_not_allowlisted` and deny-rule codes also occur.
- Where it appears (65c/178): optional `skipped_actions` (`skippedActionsSchema`, max `SKIPPED_ACTIONS_MAX` = 100)
  on `run.completed`, `run.failed`, `run.interrupted`. Old payloads decode unchanged. Beyond 100 the list is
  truncated; the true count goes in the notification's `skipped_count`. Individual denials are still visible
  as existing `policy.denied` events; the terminal field is the summary the notifier and web read.
- Notification (`notificationSchema`, strict): `{notification_id, kind, schedule_id, thread_id|null,
run_id|null, skipped_count?, paused_by?, read_at|null, created_at}`. Kinds `NOTIFICATION_KINDS`:
  `schedule.run.succeeded|failed|interrupted|skipped_actions|paused`. No prompt or message text; the web
  loads the thread for content. A run with skips but status completed emits `skipped_actions` (not
  `succeeded`); failed/interrupted keep their kind (and `skipped_count` may be added later if wanted).
  `thread_id`/`run_id` are null only for `schedule.paused` (`paused_by` team_admin|deactivation).
- API (65d/179): `GET /v1/notifications?unread&limit(1..100, default 50)&cursor` ->
  `{notifications, unread_count (all unread, for the badge), next_cursor|null}`, newest first.
  `POST /v1/notifications/read` body `{notification_ids: uuid[1..100]}` xor `{all: true}` ->
  `{updated, unread_count}`; already-read is a no-op. Caller sees only their own.
- Email opt-in is the existing per-schedule `notify_email` (KOBE-171); email carries the same facts and links.
- Markers: `runScheduleMarkerSchema` `{schedule_id: uuid|null}` (absent = null) for run summaries; threads use
  KOBE-171's `scheduleThreadMarkerSchema`. Server merges `.shape` into its own summary schemas.
- Pause/resume bodies already exist (KOBE-171, `POST /v1/schedules/{id}/pause|resume`, no body); no change.
  Pause/deactivation emits `schedule.paused`.
- Event Stream: only the three optional fields above; no new event type.

## Open questions (for Chris or the coordinator)

- 100-item cap and 100/50 page sizes are my choices.

## Evidence

- ac-1: `packages/protocol/src/notifications.test.ts` (strict, no input/output fields).
- ac-2: old terminal payloads decode (test "run terminal events"); existing tests green.
- ac-3: Decisions above.

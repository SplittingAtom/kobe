# KOBE-179: 65d Notifications: in-app list and optional email on success and failure

- **Status:** in review (PR # in the PR description)
- **Branch / worktree:** `kobe-179-notifications` in `../Kobe-wt179`
- **Depends on:** KOBE-174, 176, 177, 178, 180 (merged). No migration (KOBE-177 tables).

## Plan

Tests first (`services/server/src/notifications.db.test.ts`, `notifications/notifications.test.ts`, one
assertion in `scheduler/runner.db.test.ts`), then:

- `notifications/record.ts`: `notifyScheduledRunEndInTx`, called where a run becomes terminal:
  `sandbox-wire/run-state.ts` `endRunInTx` (wire) and `runs/store.ts` `applyTransition` (Stop, start
  failures, the fire-time budget block, KOBE-180 cancels).
- `notifications/email.ts`: outbox delivery (copy of `egress/request-notify.ts`, with `lease_until`).
- `notifications/store.ts` + `routes/notifications.ts` (mounted in `app.ts`); `mail/messages.ts`
  `scheduledRunMessage`; `index.ts` sweeper and a post-end delivery kick.

## Decisions

- Written in the transaction that ends the run (like KOBE-178's report), not in the post-commit
  `onScheduledRunEnded` listener: atomic with the terminal status, works on any replica, survives a
  crash. Idempotent by `notifications_run_kind_uniq` (`ON CONFLICT DO NOTHING`); the outbox row is
  written only when the notification was inserted (and `notification_emails_once`).
- Never fails the run's end (review MEDIUM-1): the insert runs in a savepoint; an error (deadlock with
  a schedule delete, which locks schedule then thread, the opposite order; or the schedule deleted
  meanwhile) rolls back only the notification and is logged with its SQLSTATE.
- Only `trigger = schedule` runs, only at their end (never per `schedule.skip`). A user's reply in a
  Scheduled thread is a user run: no notification.
- Kinds: completed -> `succeeded`, or `skipped_actions` when the run skipped any call; failed and
  `budget_stopped` -> `failed` (the fire-time budget block is a `failed` run, so it is covered);
  interrupted -> `interrupted`. `skipped_count` (true count from `run_skipped_actions`) is set on any
  kind when > 0, not only `skipped_actions` (the contract allows it).
- **`cancelled` never notifies.** Its only cause is `user_cancelled`: the owner's own Stop (they know),
  or KOBE-180 cancelling a deactivated or removed owner's runs, who must not be notified or emailed.
- Recipient = the thread's owner (= schedule owner). No notification when the thread's schedule is
  gone (deleted mid-run): the contract's `schedule_id` is a non-null uuid. For the same reason the list
  hides rows whose schedule was deleted later (FK `SET NULL`).
- Email: per-schedule `notify_email`. Delivery is per team under RLS: claim with `lease_until`
  (5 min, `FOR UPDATE SKIP LOCKED`, attempts + 1, batch 5, only rows with attempts < 8), sent / retry
  with backoff `min(2^n, 60)` min / `failed` after 8 attempts (logged), lease cleared on settle.
  Review MEDIUM-2: the claimed `attempts` is a fencing token; the lease is renewed right before each
  send and every settle requires `status = pending AND attempts = <claimed>`, so a replica whose lease
  ran out neither sends again nor overwrites the row. A pending row at 8 attempts whose lease ended
  (crash mid-attempt) is marked `failed` (`max_attempts`). Turned off after the run: `notify_off`.
  Mail errors are logged by code only (an SMTP message can quote the address). Skipped (`recipient_inactive`) when the
  owner is deactivated or no longer a team member at delivery. Kicked right after the end via the
  KOBE-174 hook (any process), swept every 60 s on server replicas.
- Email content: outcome, team name, when the schedule runs ("daily at 09:00 (Europe/Berlin)") and
  links (`/?thread=<id>`, `/me/schedules`). Schedules have no name column and the thread title is the
  prompt's first line, so neither is used. Team name and recurrence text go through `oneLine()`.
- API per KOBE-176: `GET /v1/notifications` (`unread`, `limit`, opaque keyset cursor on
  `(created_at, id)` with microsecond precision; bad cursor 400) and `POST /v1/notifications/read`.
  `requireTeam` only (any member); every query in `withTeam()` and filtered by the caller's
  `user_id`. Someone else's id in mark-read is silently not counted (`updated: 0`).
- `schedule.paused` notifications are not emitted here (ticket scope is run ends).
- No daily email cap (coordinator, review L2): email is opt-in in the API (`notify_email` false by
  default), schedules fire at most every 15 min, at most 10 active per user, only to the owner.

## Open questions (for Chris or the coordinator)

- `schedule.paused` (team-admin pause / deactivation, in the KOBE-176 contract) has no producer yet.
  Deactivation should not notify the deactivated owner; a team-admin pause probably should. Follow-up?
- No OpenAPI entry (the document covers threads/runs/approvals only).

## Evidence (acceptance criteria → test or command output)

- ac-1: `notifications.db.test.ts` "a notification per scheduled run end" (succeeded, failed,
  interrupted, budget stop, skipped actions with count; user runs and cancelled runs none; idempotent);
  `scheduler/runner.db.test.ts` "a budget-blocked run fails visibly" (one `schedule.run.failed`).
- ac-2: same file "email through the outbox" (sent once to the owner, SMTP failure then retry after
  backoff, give-up at 8, lease respected, stale replica is a no-op, row at 8 attempts not claimed,
  `notify_off`, none when off, deactivated/removed owner skipped). Run end survives a failing notify
  step: "a failing notify step never stops the run from ending (savepoint)". Bad cursor dates 400.
- ac-3: same file "names that try to break a header", `SECRET` prompt/output never in mail or list;
  "the owner's list and mark read" (teammate and other team see nothing, paging, mark read own only).
- `pnpm --filter @kobe/server test:db`, `pnpm verify`, CI on the PR.

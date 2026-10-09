# KOBE-171: 64a Schedules contract (recurrence, CRUD, cap, errors, Scheduled marker)

- **Status:** in review
- **Branch / worktree:** `kobe-171-schedules-contract` in `../Kobe-wt171`
- **Depends on:** none. Blocks KOBE-172 (migration), 173 (API), 174 (runner), 175 (web), 176 (scheduled-run contract). Spec D32.

## Plan

`packages/protocol` only, additive, tests first. New `schedules.ts` (one export line in the index).
`runTriggerSchema` (`schedule`) and policy `Actor.kind='schedule'` are reused unchanged.

## Decisions (dependants must follow)

- Recurrence (`scheduleRecurrenceSchema`, strict, discriminated on `kind`): `{kind:"cron", expr}` |
  `{kind:"daily", at}` | `{kind:"weekdays", at}` (Mon-Fri) | `{kind:"weekly", days:["mon".."sun"] unique 1-7, at}`.
  `at` = `HH:MM` 24 h zero-padded, local to `tz`. `tz` is a sibling field, not inside recurrence
  (`scheduleTimezoneSchema`: IANA name via Intl; `+01:00`/`UTC+2` rejected).
- Cron is strict: 5 numeric fields, single spaces; `*`, `a`, `a-b`, step forms, comma lists; dow 0-7
  (0 and 7 = Sunday); no names, `?`, `L`, `@daily`. `parseCron(expr)` / `cronMinIntervalMinutes(expr)` are
  exported for the runner (64d/174 computes `next_due_at`, DST: nonexistent local time fires at next valid
  instant, repeated time fires once). Min gap `SCHEDULE_MIN_INTERVAL_MINUTES` = 15 (coordinator may change;
  one constant). Presets (daily/weekdays/weekly) are not interval-checked (always >= 1 day).
- Cap: `MAX_ACTIVE_SCHEDULES_PER_USER` = 10, counted over `active = true` across ALL of the user's teams.
  Create with `active:true`, PATCH `active:true` and resume all check it. Inactive schedules are unbounded.
- Bodies: `createScheduleBodySchema` `{agent_id, prompt (1..SCHEDULE_PROMPT_MAX=10000, not blank), recurrence,
tz, active=true, notify_email=false}`; `patchScheduleBodySchema` any subset (>=1), no defaults, strict;
  `listSchedulesQuerySchema` `{scope: mine|team}` (default `mine`; `team` = team admins' inventory).
  Server sets `user_id` (caller) and `team_id` (request).
- Response `scheduleResponseSchema`: `{schedule_id, team_id, user_id, agent_id, prompt, recurrence, tz, active,
notify_email, next_due_at|null, last_run_id|null, paused_by: null|"team_admin"|"deactivation",
created_at, updated_at}`. List: `{schedules, active_count}` (`active_count` = caller's active across teams).
- Pause/resume: `POST /v1/schedules/{id}/pause` and `/resume`, no body, answer `scheduleResponseSchema`.
  Owner pause: `active=false, paused_by=null`. Team admin pause: `paused_by="team_admin"` (only a team admin
  resumes it). Deactivation/team removal: `paused_by="deactivation"` (owner resumes after reactivation). Resume
  clears `paused_by`, recomputes `next_due_at`, counts against the cap. `next_due_at` null while inactive.
  Not a contract matter, proposed for 173: those rules, and 403/404 via the platform's usual error body.
- Errors `scheduleErrorSchema` `{code, message, active_count?, limit?}`, status in
  `SCHEDULE_ERROR_HTTP_STATUS`: `schedule_cap_reached` 409 (carries `active_count` and `limit`),
  `invalid_recurrence` 422, `invalid_timezone` 422, `agent_not_runnable` 422 (agent suspended, draft-only, or
  not visible to the user in this team). 173 maps zod issues at path `recurrence` -> `invalid_recurrence`,
  `tz` -> `invalid_timezone`.
- Scheduled folder: protocol has no thread summary schema (it lives in `services/server/src/threads/schemas.ts`),
  so this PR exports `scheduleThreadMarkerSchema` = `{schedule_id: uuid|null}` (absent decodes as null).
  KOBE-173 merges `.shape` into the server's `threadSummarySchema` (+ OpenAPI snapshot) and 172 adds the
  column; web (175) filters `schedule_id != null`. The existing thread schemas are untouched here.

## Open questions (for Chris or the coordinator)

- 15 min minimum interval and 10 000 char prompt are my choices (brief gave no numbers).
- AC-2 wording says the thread summary "carries" schedule_id; with a contract-only protocol PR that lands in 173.

## Evidence

- ac-1: `packages/protocol/src/schedules.test.ts` (each form, cron strictness, interval, tz, constants, codes).
- ac-2: marker test ("Scheduled folder marker"); no existing schema changed.
- ac-3: Decisions above.

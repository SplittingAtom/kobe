# KOBE-175: 64e Web: schedules page and Scheduled folder

- **Status:** in review
- **Branch / worktree:** `kobe-175-schedules-web` in `../Kobe-wt175`
- **Depends on:** KOBE-171 (contract), KOBE-173 (API). apps/web only; no server or migration changes.

## Decisions

- `/me/schedules` (`MySchedulesPage`, form in `schedule-form.tsx`), client `lib/schedules/api.ts`, words and zone helpers `lib/schedules/format.ts`. Linked from the chat header next to My memory.
- Presets daily / weekdays / weekly / cron; time zone defaults to the browser's, any IANA zone selectable. Next run is shown in the schedule's own zone, with the zone name.
- Admin-paused (`paused_by=team_admin`): status "Paused by a team admin", Resume disabled. Server errors (cap 409, 422 validation, 403) show the server message through `ErrorNotice`.
- Agent picker uses `/v1/agents/runnable`. Prompt and names are rendered as React text only.
- Scheduled folder: `scheduleId` on `ThreadSummary`; the session records scheduled thread ids from list/summary answers (`noteScheduled`). The sidebar gets a Scheduled tab; Conversations hides schedule threads; Trash shows all.
- Fake server (`fake-kobe.ts`) gained `setScheduleId` and `schedule_id` in summaries.

## Evidence

- ac-1, ac-2: `components/me/my-schedules.test.tsx` (mocked API).
- ac-3: `components/chat/scheduled-folder.test.tsx`.

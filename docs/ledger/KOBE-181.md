# KOBE-181: 65f: Web and e2e: notifications, run report, team schedules; scheduled-run e2e

- **Status:** in review (PR #237)
- **Branch / worktree:** `kobe-181-schedules-web-e2e` in `../Kobe-wt181`
- **Depends on:** KOBE-175, KOBE-178, KOBE-179, KOBE-180 (all merged)

## Plan

- Web: notification bell in the chat header; skipped-actions card in a scheduled run's thread;
  notify-email toggle on the schedule form; team console page `Schedules` (pause/resume).
- E2e: `e2e/scheduled-runs.sh`, sourced by `e2e/run.sh` (suite shard), with a 5 s scheduler tick in
  `dev/values.yaml`.

## Decisions

- **Bell** (`components/chat/notification-bell.tsx`, client `lib/notifications/api.ts`): in the chat
  header once a team is active. Badge = `unread_count` of `GET /v1/notifications?unread=true&limit=1`,
  asked on mount, every 60 s and on window focus. The panel lists 20 per page (newest first) with an
  "Unread only" filter, "Load more" by `next_cursor`, "Mark read" per item and "Mark all read"; every
  answer's `unread_count` updates the badge. "Open conversation" marks the item read, then opens
  the thread in place (`?thread=` + a `popstate` the chat's URL hook already follows).
- Schedules have no name (KOBE-179): an item names its schedule by recurrence and zone from
  `/v1/schedules?scope=mine` ("Every day at 09:00 (Europe/Berlin)"); a deleted schedule says so.
  Nothing else is shown: notifications carry ids and outcomes only.
- **Skipped-actions card**: `parseEntry` recognises the server's `custom_message`
  (`customType` `kobe.skipped_actions`, KOBE-178). `projectThread` keeps these entries out of the
  tree entirely and appends a `data-kobe-skipped` part to the assistant message holding their
  parent. So the summary is never a message, a head, a branch, or `lastEntryOfNode` (the entry a
  branch switch or edit continues from), which the server would refuse (422 `invalid_parent_entry`,
  404 on the leaf). Rendered as plain text: title with the count, intro line, one item per call.
- **Notify email toggle**: "Email me when a run ends", off by default (KOBE-179: opt-in); sent as
  `notify_email` on create and edit.
- **Team schedules page** (`/admin/team/schedules`, permission `team.schedules.pause`, group
  "Agents and skills"): `GET /v1/schedules?scope=team` (KOBE-180: no separate route) plus the roster
  for owner names ("Former member" when gone). Prompts are the owner's and are not shown; rows are
  owner, recurrence, status, next run. Pause for active schedules; Resume only for admin-paused ones
  (the server 404s the rest), disabled with the reason otherwise. Server errors (409
  `schedule_owner_inactive`, …) through `MutationStatus`/`ErrorNotice`.
- **E2e seam**: no server change. Schedules are created through the API (daily, 12 h away), one
  occurrence is pulled due in Postgres (`next_due_at = now() - 1 s`), and the runner fires it within
  one tick. `dev/values.yaml` (dev and e2e only) sets `scheduler.tickSeconds: 5`, the chart minimum;
  the chart default stays 15 (chart test pins both).
- E2e failure path: a member with a zero monthly token budget (`PUT /v1/team/budgets/members/:id`):
  the fire is a `failed` run (`budget_blocked`), which needs no sandbox. Success and the skipped
  write use the Owner's real sandbox and the fake model (`bash: …` → a bash call, denied with
  `scheduled_run_no_prompt`). The member is then deactivated: paused (`deactivation`), not fired when
  pulled due while paused, and skipped (`user_inactive`) at fire time when the pause is removed by
  hand (a lost hook). Admin resume of that schedule is a 404 (only admin-paused schedules), so the
  409 `schedule_owner_inactive` path is covered by the component test, not the e2e.
- The e2e section runs in the `suite` shard only (skipped with the executor on).

## Open questions (for Chris or the coordinator)

- None.

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/chat/notification-bell.test.tsx` (badge, list, mark read, mark all,
  filter and paging, open thread), `components/chat/scheduled-folder.test.tsx` (card in the thread,
  bell opens the Scheduled thread), `lib/chat/tree.test.ts` (summary never a branch point),
  `components/admin/team-schedules-page.test.tsx` (pause/resume, 409 message),
  `components/me/my-schedules.test.tsx` (notify toggle), `lib/notifications/*.test.ts`.
- ac-2, ac-3: `e2e/scheduled-runs.sh` in the CI e2e `suite` shard (PR checks).

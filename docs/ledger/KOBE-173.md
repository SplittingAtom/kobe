# KOBE-173: 64c Schedules API (CRUD, recurrence engine, DST next-occurrence, cap)

- **Status:** in review
- **Branch / worktree:** `kobe-173-schedules-api` in `../Kobe-wt173`
- **Depends on:** KOBE-171 (contract), 172 (table). Blocks 174 (runner), 175 (web). No migration.

## Plan

Tests first: `schedules/recurrence.test.ts` (pure), `schedules.db.test.ts` (HTTP, RLS, cap).
`services/server/src/schedules/{recurrence,store,http}.ts`, `routes/schedules.ts` (one mount line),
audit events `schedule.*`, thread summaries gain `schedule_id`.

## Decisions (dependants must follow)

- Routes (team header as everywhere, permission `team.schedules.personal`): `GET /v1/schedules?scope=mine|team`,
  `POST`, `GET|PATCH|DELETE /:id` (DELETE answers 204), `POST /:id/pause`, `POST /:id/resume`. List returns
  `{schedules, active_count}`; `active_count` spans all of the caller's teams.
- Other users' and other teams' schedules are 404 `schedule_not_found`, identical to a missing id, for every
  operation. Team admins (`team.schedules.pause`) may list `scope=team` (members get 403), pause any
  schedule (`paused_by=team_admin`) and resume only admin-paused ones; they get 404 on read/edit/delete.
  An owner resuming (or PATCH `active:true`) an admin-paused schedule gets 403 `paused_by_team_admin`.
- Errors: contract codes with their statuses. zod issues at `recurrence` -> `invalid_recurrence`, at `tz` ->
  `invalid_timezone`; other bad bodies, ids and queries are 400 `invalid_request`. `agent_not_runnable` uses
  `resolveAgentPin` (the thread-start rule: visible to the user in the team, active, published).
  A cron that never fires (Feb 31) is `invalid_recurrence`.
- **Cap (race-safe, no migration):** every cap check and activation (create active, PATCH `active:true`, resume)
  runs in one `withTeam` transaction that first takes `pg_advisory_xact_lock(hashtextextended('kobe.schedules:'||owner))`,
  then counts active schedules in the current team and in each of the owner's other teams (`listMemberships`, read
  BEFORE the transaction so waiting requests never hold a connection while needing a second one). The count
  switches the transaction-local `kobe.team_id` per team and restores it, so RLS stays in force. Resume by a
  team admin locks and counts the schedule owner, not the caller. 12 concurrent creates over two teams -> 10x 201,
  2x 409 (verified to fail with the lock removed). Inactive schedules are uncapped; no DB backstop (172 open
  question stands: it would need a SECURITY DEFINER function).
- `next_due_at`: computed on create (active), on PATCH of recurrence/tz while active, on activation; null while
  inactive. `schedules.cron` is the derived cron (`recurrenceToCron`).
- Recurrence engine `schedules/recurrence.ts`: pure, `Intl` based, **no tz library** (none in the repo; croner and
  luxon were not added, so no dependency or license change). Reads all five cron fields (protocol's `parseCron`
  only returns minutes/hours). DST contract, tested: gap time fires at the first valid instant after the gap
  (02:30 on a 02:00->03:00 day fires at 03:00 local, two cron times in the gap fire once); overlap fires once, at
  the FIRST occurrence; dom+dow both restricted match either (Vixie). Search horizon about 8 years.
- Audit (ids only, scope team): `schedule.created|updated|deleted|activated|deactivated` (taxonomy in
  `packages/db/src/audit/events.ts`, `docs/audit-log.md`, category test updated; no prompt text).
- Thread summaries carry `schedule_id` (`scheduleThreadMarkerSchema.shape`); `openapi.json` regenerated. Search hits
  report `schedule_id: null` (the search SQL does not read it); the thread list and detail do.

## Not done / for later

- Firing, `last_run_id`, `last_fired_at`: KOBE-174. Team-removal/deactivation pausing (`paused_by=deactivation`):
  nothing sets it yet; belongs with the runner or offboarding.
- OpenAPI path entries for `/v1/schedules` are not added (only the thread schema change).

## Evidence

- ac-1: `schedules.db.test.ts` "CRUD (ac-1)" (RLS 404s, contract codes, audit ids only, admin rules).
- ac-2: "cap of 10 ... (ac-2)": two-team cap, 409 body, resume/PATCH at cap, slot freed, 12 concurrent.
- ac-3: `schedules/recurrence.test.ts`: daily, weekdays, weekly, cron, gap, overlap, tz change, Lord Howe.

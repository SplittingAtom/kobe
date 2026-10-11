# KOBE-180: 65e Lifecycle and governance: team-admin pause, deactivation, removal, inventory

- **Status:** in review (PR # in the PR description)
- **Branch / worktree:** `kobe-180-schedule-lifecycle` in `../Kobe-wt180`
- **Depends on:** KOBE-172..174, 177, 178 (merged). No migration. FLAG: authz and deactivation path, Opus review.

## Plan

Tests first (`services/server/src/schedule-governance.db.test.ts`, inventory case in
`apps/web/components/admin/team-pages.test.tsx`), then:

- `schedules/offboard.ts`: `pauseOwnerSchedulesInTx` (pause in the caller's `withTeam()` tx) and
  `stopUserSchedules` (the `deactivated` lifecycle hook, registered first in `deps.ts`).
- `runs/cancel-scheduled.ts` + `ServerRunOrchestrator.cancelScheduledRuns(teamId, userId, reason)`.
- `teams/members.ts` `removeMember` pauses in its own transaction; `routes/team.ts` then cancels runs.
- `agents/inventory.ts`: `schedules` per agent; scheduled install agents join the inventory.
- Audit taxonomy: `schedule.deactivated.by` += `deactivation`, `member_removed`; `run.cancelled.reason?`.

## Decisions

- Deactivation and team removal both set `paused_by = deactivation` (the only non-admin value the
  KOBE-172 check allows); the audit `by` tells them apart (`deactivation` | `member_removed`). Only
  ACTIVE schedules are touched: an admin pause (sticky, KOBE-173) and an owner pause stay as they were.
- Reactivation / rejoining changes nothing: schedules stay paused until the owner resumes each
  (coordinator, 2026-10-09). The owner may resume a `deactivation` pause; a team admin cannot (404,
  the KOBE-173 rule "admins resume only admin-paused schedules").
- Order (no lock dance, no migration): pause first, cancel after. The pause UPDATE waits for a fire
  holding the schedule row (KOBE-174 lease), so a run fired just before is committed and found by the
  cancel; a fire after the pause sees the schedule inactive. The deactivation hook does this outside
  `deactivateUser`'s transaction on purpose: pausing inside it would hold the user row while waiting
  for a fire that waits on that row (`principalActive` FOR SHARE), a deadlock.
- Removal pauses inside `removeMember`'s transaction (atomic with the membership delete; it locks only
  `team_members`, which a fire does not lock). Only that team's schedules and runs; other teams untouched.
- Cancelled runs: only `trigger = schedule` runs of the owner's threads (queued, running,
  waiting_approval), ended like a Stop (`cancelled`/`user_cancelled`, the only cause the contract has
  for `cancelled`; abort requested durably; KOBE-178 skipped-actions report applies). Audit
  `run.cancelled` as the system with `reason` `owner_deactivated` | `member_removed`. Interactive runs
  are left to the existing sandbox teardown (offboarding).
- Pause/cancel audits use `SYSTEM_ACTOR`: they are consequences; the triggering act
  (`identity.user.deactivated`, `identity.member.removed`) carries the human actor.
- ac-2: no new `routes/team-schedules.ts`. KOBE-173 already serves the team-admin API on
  `/v1/schedules` (`scope=team` list, pause, resume; `team.schedules.pause`; team from `requireTeam`,
  every query in `withTeam()`; other teams' ids 404). Duplicating it would add a second authz surface.
  The new test pins the admin flow, its audit (`by: team_admin`) and the cross-team 404.
- ac-3 inventory: `schedules: InventorySchedule[]` (id, owner id and name, `active`|`paused`,
  `pausedBy`, `nextDueAt`) replaces the `null` placeholder; web renders "owner: status". A personal
  agent that only a schedule uses now appears in the inventory and can be suspended for the team.
- Suspended or unpublished agents keep the KOBE-174 fire-time behaviour: skipped (`agent_unavailable`),
  occurrence consumed, schedule stays active so it resumes firing when the agent is back. Not paused.

## Open questions (for Chris or the coordinator)

- A suspended or unpublished agent's schedules write one `schedule.skip` per occurrence until the
  agent is back (KOBE-174 behaviour). Pausing them instead would need a reason value the KOBE-172
  check does not allow (a migration). Say if wanted.
- Team removal reuses `paused_by = deactivation`; web shows "paused (owner deactivated or removed)".

## Evidence (acceptance criteria → test or command output)

- ac-1: `schedule-governance.db.test.ts` "deactivation stops the user's schedules" (both teams paused,
  owner pause untouched, running and queued scheduled runs cancelled, audits, nothing fires and no skip
  rows next day, reactivation keeps them paused, owner resumes); "removal from a team stops only that
  team's schedules".
- ac-2: same file "team admin governance" (list, pause, owner 403 on resume and PATCH, admin resume,
  audit trail; another team's admin gets 404). Existing `schedules.db.test.ts` admin cases still pass.
- ac-3: same file "inventory lists schedules" (owner, status, pausedBy, scheduled personal agent;
  inventory suspension and unpublished agent do not fire); web `team-pages.test.tsx` "lists each
  agent's schedules".
- `pnpm --filter @kobe/server test:db`, `pnpm verify`, CI on the PR.

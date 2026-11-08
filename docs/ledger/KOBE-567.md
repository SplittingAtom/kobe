# KOBE-567: Server: roster-driven resolution, owner eligibility, schedule pause/resume

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** blocked: needs a migration (see Blocker). Work committed on the branch, not pushed.
- **Branch / worktree:** `kobe-567-roster-resolution` in `../Kobe-wt567`
- **Depends on:** KOBE-565, KOBE-566. Spec `docs/specs/agents-roster.md` AR5, AR8-AR11, §6.2, §6.5.

## Blocker

The DB trigger `threads_agent_pin_owner` (0020, recreated in 0091) refuses a thread pin to a
personal agent unless `site_agents.owner_user_id = threads.owner_user_id`
(`23514 thread pin: agent … is not a personal agent available to the thread owner`). Roster
resolution pins someone else's personal agent, so `POST /v1/threads` answers 500. Needed (own
hand-written migration PR): accept a personal pin also when the agent has an entry for
`NEW.team_id` on `team_agent_roster` (active) or on `site_agent_roster` (active), and not when it
is bound to another team. The trigger also fires on `UPDATE OF owner_user_id`: decide whether any
entry state (removed included, D19) is enough there.

## Decisions

- **Thread pin trigger (PR 1/2, `0195_thread_pin_roster`, coordinator-approved 2026-11-08):** a
  personal pin is valid for the agent's owner, or with an `active` team entry for the thread's team
  or an `active` site entry, the agent not bound elsewhere. Re-checked on INSERT and on an UPDATE
  that changes `agent_scope`/`agent_id`/`agent_version` **or `owner_user_id`**: the owner re-check
  is kept as the existing M2 security behaviour (a pinned thread can't be moved to someone who may
  not use the agent); no server path changes a thread's owner, so D19 (pins survive removal and
  owner departure) is unaffected. Renames, moves and archives never re-validate.

## Done (server, tests green except the three thread-creation tests behind the trigger)

- `agents/roster-resolution.ts`: `lendingIn` (pure), `entryUnavailable`, `ownerStates`,
  `lentAgents` (other members' agents lent by team/site roster at the resolved version, frontmatter
  of that version, never the draft; Unavailable → `currentVersion: null`), `keptLentAgent` (a
  thread keeps running its pin after removal, D19), `notBoundElsewhere` (AR8).
- `versions.ts` (+~8 lines): `findPinnableAgent` falls back to `lentAgents`; `resolveSwitchPin`
  limits a lent agent to the version in effect; `resolvePinnedAgent` falls back to `keptLentAgent`.
- `runnable.ts`: lent agents included; bound own agents only in their team; default marking via
  `teamDefaultAgentId` (hook in `default-agent.ts`, returns null until KOBE-571 adds the setting;
  site default Kobe is the fallback).
- `roster-list.ts` + protocol: status `unavailable`, optional `unavailableReason`
  (`owner_left|owner_deactivated`); rows shown only to the roster's admins.
- Schedules (`agents/roster-schedules.ts`): pause `agent_unavailable` + `schedule.paused`
  notification (in-app; email path does not render paused yet) + audit `by: agent_unavailable`;
  resume (`by: agent_available`). Hooked in team roster writes (same tx), site writes (after
  commit, all teams), member removal (`offboard.ts`), scheduler tick (`sweepAgentSchedules`).
  `offboard.ts`/`owner-sweep.ts` re-pause filters include `agent_unavailable`. Owner resume of an
  agent-paused schedule is 422 `agent_not_runnable` until the agent is back.
- `pausedBy` typed with protocol `SchedulePausedBy` (server inventory/notifications, web files from
  the KOBE-565 hand-off); label "Paused: agent unavailable".

## Evidence

- Unit: `services/server/src/agents/roster-resolution.test.ts` (8 pass).
- DB: `services/server/src/agent-roster-resolution.db.test.ts`: schedules (ac-3, 3 tests), site
  deactivated owner, bound agent pass; ac-1 (2) and ac-2 owner-left fail only at thread creation
  (trigger).

## Open for 568/569/571/572

- 571: implement `teamDefaultAgentId` (setting) — runnable and `defaultNewThreadPin` already use it.
- 569/570: render `status: unavailable` with `unavailableReason`.
- Not yet run: `pnpm verify`, full `test:db`.

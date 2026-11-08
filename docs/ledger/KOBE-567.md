# KOBE-567: Server: roster-driven resolution, owner eligibility, schedule pause/resume

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR 2/2); the trigger change landed first as PR 1/2 #484.
- **Branch / worktree:** `kobe-567-roster-resolution` in `../Kobe-wt567`
- **Depends on:** KOBE-565, KOBE-566. Spec `docs/specs/agents-roster.md` AR5, AR8-AR11, §6.2, §6.5.

## Blocker (resolved)

`threads_agent_pin_owner` refused pins of someone else's personal agent; fixed by #484
(`0195_thread_pin_roster`, see Decisions).

## Decisions

- **Thread pin trigger (PR 1/2, `0195_thread_pin_roster`, coordinator-approved 2026-11-08):** a
  personal pin is valid for the agent's owner, or with an `active` team entry for the thread's team
  or an `active` site entry, the agent not bound elsewhere. Re-checked on INSERT and on an UPDATE
  that changes `agent_scope`/`agent_id`/`agent_version` **or `owner_user_id`**: the owner re-check
  is kept as the existing M2 security behaviour (a pinned thread can't be moved to someone who may
  not use the agent); no server path changes a thread's owner, so D19 (pins survive removal and
  owner departure) is unaffected. Renames, moves and archives never re-validate.

- **Review decisions (coordinator, 2026-11-08):** a site-wide suspension of a site entry wins over
  an active team entry (not runnable anywhere, runs refused); schedules of gallery agents also pause
  `agent_unavailable` when the team suspends them; team-owned agents keep their status rules.

## Done (server)

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

- Unit: `services/server/src/agents/roster-resolution.test.ts` (`lendingIn`, `entryUnavailable`,
  `isLentAgent`).
- DB: `services/server/src/agent-roster-resolution.db.test.ts` (8): ac-1 latest → pin → thread
  keeps its pin after removal, switch limited to the version in effect, other team isolated; site
  entry and suspensions; bound agent. ac-2 owner left (Unavailable + reason for admins, hidden for
  members, thread still runs) and site owner deactivated. ac-3 pause/notify/resume on removal,
  suspension here and site-wide, owner leaving and rejoining (tick), gone schedule owner never
  resumed. Trigger: `packages/db/src/thread-pin-roster.db.test.ts` (#484).
- `pnpm verify` steps green (format, lint, typecheck, unit, `test:db`, license, hygiene, wording);
  three load timeouts in untouched packages (db upgrade, mcp-proxy probe, model-gateway gateway)
  pass alone. `openapi.json` regenerated (roster status `unavailable`, `unavailableReason`).

## Open for 568/569/571/572

- 571: implement `teamDefaultAgentId` (setting) — runnable and `defaultNewThreadPin` already use it.
- 569/570: render `status: unavailable` with `unavailableReason`.
- 572: browser spec "owner leaves" can assert the Unavailable row and the paused schedule label.
- Email for `schedule.paused` is not rendered by the notifier (in-app only), as before.

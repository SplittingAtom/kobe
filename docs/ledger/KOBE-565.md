# KOBE-565: DB: agent roster tables, bound_team_id, schedule pause reason

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-565-agent-roster-db` in `../Kobe-wt565`
- **Depends on:** none (spec `docs/specs/agents-roster.md` §4 AR3/AR5/AR8/AR11, §6.1; the migration
  PR every other roster ticket, KOBE-566..573, builds on)

## Plan

DB only: schema `packages/db/src/schema/agent-roster.ts`, `site_agents.bound_team_id`,
`schedules.paused_by` value, one generated migration (`0193_agent_roster`) plus custom RLS
(`0194_agent_roster_rls`), tenancy lists (`tenancy/agents.ts`), probe fixture.

## Decisions

- **`paused_by`, not `paused_reason`.** The spec's `schedules.paused_reason` is the existing
  `schedules.paused_by` column; `agent_unavailable` is a new value of `SCHEDULE_PAUSED_BY`. The
  CHECKs `schedules_paused_by` and `notifications_paused_by` both derive from that list, so
  `schedule.paused` notifications accept it too. **KOBE-567: use `paused_by = 'agent_unavailable'`**
  and widen the hand-written unions that still list two values (server `agents/inventory.ts`
  `InventorySchedule.pausedBy`; web `lib/schedules/api.ts`, schedules pages' labels).
- **No foreign key from either roster to `site_agents`** (coordinator, like
  `team_agent_suspensions`), although spec AR3 reads "→ site_agents (NO ACTION)". The server must
  enforce 409 `agent_rostered` on delete (KOBE-566/§6.3); a row for a deleted agent is inert.
- **Version rule as two columns:** `version_rule` (`latest`|`pinned`) and `pinned_version`
  (integer > 0), CHECK `(version_rule = 'pinned') = (pinned_version IS NOT NULL)`.
- **States** `proposed|active|removed|suspended` (coordinator adds `suspended` to the spec's three);
  defaults `state = 'active'`, `version_rule = 'latest'`. Primary keys: (team_id, site_agent_id)
  and (site_agent_id) serve the unique constraints; index `team_agent_roster_agent_idx` on
  `site_agent_id` for "Reach"/owner-leaves lookups (the site table's PK already covers it).
- `assigned_by`/`decided_by` → `users` (NO ACTION, users are never deleted). No length CHECK on
  `note`: the server validates it.
- `site_agent_roster` is site-wide with `ALL_PRIVILEGES` for the app role (the server decides who
  writes); no RLS, no team reference.
- `site_agents.bound_team_id uuid null`, no FK; CHECK `site_agents_bound_team_scope`
  (`bound_team_id IS NULL OR scope = 'personal'`).
- Migration is expand-only (new tables, nullable column, CHECKs that widen or hold for all rows
  since the new column is null).

- **Protocol widened (additive):** `@kobe/protocol` `SCHEDULE_PAUSED_BY` gains `agent_unavailable`,
  because the server's `schedules/store.ts` maps the DB row straight into `ScheduleResponse` and
  the root typecheck failed without it. No other server or web change.

## Open questions (for Chris or the coordinator)

- The protocol enum change sits in this DB PR (parallel-work says contracts change in their own
  PR); it is one additive value, needed for the build. Coordinator to accept or split. Spec AR3 lists three states; `suspended` was added per the lane brief.

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db/src/agent-roster.db.test.ts` (RLS isolation, WITH CHECK, unique, checks);
  `src/probe.db.test.ts` (cross-team probe incl. the new `team_agent_roster` fixture) green.
- ac-2: same file, `site_agents.bound_team_id` and `schedules.paused_by agent_unavailable` blocks.
- ac-3: `pnpm --filter @kobe/db db:check` clean after commit; `test:db` full run green; CI `db` job.

# KOBE-86: 48c: Agent inventory and suspend

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-86-agent-inventory` in `../Kobe-wt86`
- **Depends on:** KOBE-45/46 (agents, pins), KOBE-76 (run-start resolver), KOBE-84 (builder), KOBE-43 (`run_usage`)

## Plan

- Team agents already had `status` (active/suspended) and `PUT /v1/agents/:id/status`
  (`team.agents.suspend`, audited as `agent.status_changed`). Personal and gallery agents are
  install-wide, so a team can't use their own `status` (it would reach other teams).
- New team table `team_agent_suspensions (team_id, agent_id, agent_scope, suspended_by, suspended_at)`:
  a team admin suspends a used personal/gallery agent for that team only.
- `GET /v1/agents/inventory` (keyset pages by `(slug, id)`, `limit` <= 200, `cursor`) and
  `PUT /v1/agents/inventory/:id/status`, both `team.agents.suspend`.
- Web: inventory section on the team agents page; builder banner for a suspended agent.

## Decisions

- Migrations `0052_agent_suspensions` (table) and `0053_agent_suspensions_rls` (ENABLE/FORCE RLS +
  policy, custom). Tenancy entry in `tenancy/agents.ts`, probe fixture in `probe-fixtures/agents.ts`.
  No foreign key to `install_agents` (install-wide data; a row for a deleted agent is inert).
- "Used in this team" = a thread of this team pinned to the agent (`threads.agent_id`, scope personal
  or gallery). Gallery agents used here are listed too. Every query states `team_id` explicitly
  (threads, runs, run_usage, suspensions), on top of `withTeam()`.
- Effective status = install-wide `status` suspended OR a suspension row for this team. It is applied
  in `findPinnableAgent`, so new threads, version switches and run start all see it (`agent_suspended`
  from `resolvePinnedAgent`).
- Run start: a suspended agent fails the queued run with code `agent_suspended` and a clear message
  (was the generic `agent_unavailable`). The failure is the run's own `run.failed` event.
- Usage: run count (runs of this team's threads pinned to the agent, any version), last run, and
  input+output tokens from `run_usage.agent_id` (advisory attribution). No money is shown, so
  `cost_usd_exact` is not used. Schedules and Orbit score are `null` in the API and "—" in the UI.
- The suspend button moved from the old list to the inventory (one place, all scopes); the old
  list keeps Edit links and still shows the status. Builders (no suspend right) get no inventory.
- The builder shows a banner for a suspended agent and stays editable and publishable.

## Open questions (for Chris or the coordinator)

- A suspension row is checked inside the run-start transaction but not row-locked
  (`findPinnableAgent` locks the agent row `FOR SHARE`, not the suspension): a suspend committing
  between pin check and run start can let that one run through. Team agents keep the lock.
- Personal agents the owner sees as `status: active` in their own list even when a team suspended
  them there (status is per team; the chat app could show it later).

## Evidence (acceptance criteria -> test or command output)

- ac-1 suspended agents can't start runs: `runs-review.db.test.ts` "pinned agent at run start"
  (team agent, and personal agent suspended by a team row, both fail with `agent_suspended`);
  `agent-inventory.db.test.ts` "suspends and reactivates" (new threads refused,
  `agent_unavailable`; reactivation restores them); per-team row and audit event asserted there.
- ac-2 inventory lists team and used personal agents: `agent-inventory.db.test.ts` "lists team
  agents and personal agents used in the team" (not another member's unused agent, not another
  team's agent), "pages", "is for team admins only"; UI in `team-pages.test.tsx` "Agent inventory".
- Probe suite: `pnpm --filter @kobe/db test:db` (new table covered by the tenancy registry).
- `pnpm verify`: see PR.

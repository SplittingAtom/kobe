# Agents roster lane (KOBE-565..573)

Spec: `docs/specs/agents-roster.md` (Hadron spec `4a057ebf-622f-4e43-aa23-7ac7a9e25edb`); decisions by
Chris 2026-11-08 (Q1, Q3, Q6 explicit, the rest the proposed answers). Companions: agent-creator.md,
gallery-agents.md, docs/agent-versions.md.

## Order and lanes

1. **KOBE-565** (AR-1) DB: `team_agent_roster`, `site_agent_roster`, `site_agents.bound_team_id`,
   `schedules.paused_reason agent_unavailable`; RLS, probes. Alone first (every other ticket needs it).
2. **KOBE-566** (AR-2) server roster read/writes, access matrix, audit.
3. In parallel after 566: **KOBE-567** (AR-3) resolution + schedules; **KOBE-568** (AR-4) fork
   binding, transfer, adopt; **KOBE-569** (AR-5) web tabs.
4. After 569: **KOBE-570** (AR-6) admin fold-in and proposals queue; after 568 + 569: **KOBE-571**
   (AR-7) fork dialog, lineage, version rule UI, picker grouping, team default agent.
5. **KOBE-572** (AR-8) gate1 browser specs; **KOBE-573** (AR-9) docs.

Group branches per `docs/parallel-work.md` (one PR per group); Opus review on 566, 567 and 568
(authz, RLS, resolution); DB tests with `KOBE_TEST_DATABASE_URL`.

## Rules the agents must keep (from the spec)

- Rosters hold ids and timestamps only; the owner is the only editor; a roster entry's version rule
  (latest or a pin) decides what a team runs; threads keep their pinned version.
- Fork always lands in Personal; a fork of team-owned or team-assigned content is bound to that team
  (`bound_team_id`), never assignable elsewhere (`422 agent_bound_to_team`).
- Builders assign to the team directly, site admins to the site; others propose (`202 proposed`).
- Delete while rostered is refused (`409 agent_rostered`); archive hides from rosters.
- Dangerous mode, policy floors, run execution and version immutability are untouched.

## Evidence

(filled by the ticket agents: PR numbers, gate1 tags, spec runs)

# KOBE-573: Docs: agents roster guide, permission matrix, audit rows, spec marked shipped

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review
- **Branch / worktree:** `kobe-573-roster-docs` in `../Kobe-wt573` (group branch `pipeline-b`)
- **Depends on:** KOBE-565..572 (all merged). Spec `docs/specs/agents-roster.md` §10 AR-9.

## Done

- `docs/agents.md` (new): Agents page and tabs, statuses, Reach, rosters as references, version
  rule, assign/propose/decide/withdraw/remove, runnable set and picker, View, team default agent,
  fork and binding, transfer and adopt, suspension/archive/delete, schedules pausing
  (`schedules.paused_by = agent_unavailable`), the §5 matrix, API, errors, audit, not built yet.
  Every claim checked against `services/server/src/agents/*`, `routes/agent-roster.ts`,
  `routes/agent-transfer.ts`, `@kobe/protocol` `agent-roster.ts`, `authz/permissions.ts` and
  `apps/web/components/agents/*`, `lib/agents/*`.
- `docs/audit-log.md`: the roster, transfer and adopt rows already existed (KOBE-566/568) and match
  `packages/db/src/audit/events.ts`; corrected `agent.roster.assigned` (by-reference assignment),
  `.removed` (adopt), `.suspended` (team-owned agents and the Inventory API log
  `agent.status_changed`), and `team.default_agent_changed`, whose description was a copy of
  `models.followups.changed`.
- `docs/specs/agents-roster.md`: status shipped with tickets and PRs.

## Shipped behaviour that differs from the spec (docs follow the code)

1. **Schema:** `schedules.paused_by = 'agent_unavailable'`, not a `paused_reason` column; roster
   tables have no foreign key to `site_agents` (entries of a deleted agent are inert); the version
   rule is two columns (`version_rule`, `pinned_version`); entry states add `suspended`, used only
   on the site roster (KOBE-565).
2. **Team suspension** lives only in `team_agent_suspensions`; a team entry stays `active`. A
   site-wide suspension wins over an active team entry (KOBE-566/567).
3. **Caps:** 200 assigned entries **and**, separately, 200 pending proposals per roster.
4. **Pins on assign:** only the roster's admins may send a numeric `versionRule`
   (`422 version_rule_not_allowed`).
5. **By-reference assign:** a Contributor may add someone else's site-assigned agent to the team
   (the §5 matrix), although AR6/AR16 say "owner".
6. **Withdraw from a left team:** `DELETE …/assignments/team?teamId=` (not in AR16).
7. **Adopt:** offered on any assigned entry, owner present or not (AR10 ties it to Unavailable);
   copies the agent's current published version, not the entry's pin, and publishes it as v1 at
   once; the team copy's creator is the adopting admin; the site copy is a gallery agent without a
   repository key but is **not** marked Customized (the CHECK needs a repository key). Bound agents
   cannot be adopted into the site or another team (422).
8. **Transfer:** API only, no web UI. Adds `DELETE /:id/transfer` and `GET /v1/agents/transfers`;
   one pending offer per agent site-wide; archived agents refused.
9. **Fork:** body also takes `name`; members (no `build`) cannot fork team content (403); when an
   agent is on both the site and the team roster the site entry wins (unbound copy).
10. **View:** `GET /v1/agents/:id` serves the version in effect read-only to roster readers;
    `?from=site` picks the site entry; `canExport: false` on that read.
11. **Declined marker:** a decline leaves `removedAt` null; declines recorded before KOBE-571 look
    like removals and show no "Declined".
12. **Redirects:** `/admin/team/inventory` does not redirect (AR12); it stays as the Skills and
    Connectors inventory with a pointer to the Team tab.
13. **Admin columns:** Runs, Last run, Tokens, Schedules, Orbit score (spec: "threads, last used").
    Agents used by threads but on no roster no longer appear for admins anywhere.
14. **Team default agent** is a `teams.settings` key with `GET/PUT /v1/team/default-agent`
    (console "Default agent"); members fall back to Kobe when the choice is not runnable for them.
15. **Schedules:** gallery agents' schedules also pause `agent_unavailable` when the team suspends
    them; owners cannot resume an agent-paused schedule (`422 agent_not_runnable`).
16. **Roles:** the spec's "builder" is now **Contributor** (Workspaces lane rename).
17. **Not built:** email for proposals, decisions and `schedule.paused` (in-app only); search,
    filter and sort beyond the Proposed filter; owner notifications (§7.9); "Bound to a deleted
    team" label (shows "another team"); a site roster review queue beyond `Proposed (n)` (§7.12).
    Lent agents in the picker still carry the origin chip "Personal".

## Evidence (acceptance criteria → test or command output)

- ac-1: `docs/agents.md`, `docs/audit-log.md`, `docs/specs/agents-roster.md`; `prettier --check`
  on the changed files, `scripts/check-site-wording.mjs`, `scripts/check-public-hygiene.sh` (see
  the commit).

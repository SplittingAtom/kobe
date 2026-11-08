# KOBE-566: Server: roster read and writes, access rights, audit

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #482)
- **Branch / worktree:** `kobe-566-agent-roster-server` in `../Kobe-wt566`
- **Depends on:** KOBE-565 (tables, `bound_team_id`). Spec `docs/specs/agents-roster.md` AR3-AR7,
  AR16, §5, §6.3-6.5, §6.8, §6.9 (AR-2).

## Plan

Server only, no migration. Contract `packages/protocol/src/agent-roster.ts`; rules
`agents/access.ts` (`assignDecision`, `rosterActions`, `rosterAdmin`); reads `agents/roster.ts`;
tab rows `agents/roster-list.ts`; writes `agents/roster-writes.ts`; routes `routes/agent-roster.ts`
(`/v1/agents/roster` + assignments mounted inside `agentRoutes` before `/:id`;
`/v1/team/agent-roster`, `/v1/site/agent-roster` in `app.ts`); OpenAPI `openapi/agent-roster.ts`.

## Decisions

- **Contract (camelCase like the agent API).** Request `versionRule` is `"latest"` or a version
  number; entries carry `versionRule` (`latest|pinned`) + `pinnedVersion`. Rows carry `kind`
  (`personal|team_owned|gallery`), `status` (`active|proposed|not_published|suspended_here|
suspended_site|archived`), `versionInEffect`, `updateAvailable`, `entry`, Personal `reach`, and
  `actions` (`view, viewDefinition, edit, fork, assignTeam/assignSite: direct|propose|null,
withdrawTeam/Site, decide, remove, pin, suspendHere/resumeHere, suspendSiteWide/resumeSiteWide`).
  Error codes + statuses: `AGENT_ROSTER_ERROR_STATUS`.
- **`agentAccess` unchanged; roster rights are siblings in `access.ts`.** Adding fields to
  `AgentAccess` would change every existing summary/test; `rosterActions(actor, subject, tab)` is
  the matrix, `assignDecision` is what POST enforces, so rows and writes share one rulebook.
- **§5 "builder (reference, any team)" implemented:** a builder may put someone else's
  _site-assigned_ (active) agent on their team roster directly (`assignedBy` = builder). Members
  can't. Someone else's agent not on the site roster is 404 (no oracle).
- **Suspension (§6.5 / AR9; coordinator's review decision):** for the **team** roster,
  `team_agent_suspensions` is the only record of "suspended here": a team PUT `{state: suspended}`
  or `{state: active}` (no `versionRule`) writes or deletes that row and leaves a team entry
  `active` (response `{agentId, suspendedHere}`); the read derives "Suspended here" from the row.
  Same for gallery agents and site entries; team-owned agents use their `status`
  (`agent.status_changed`). The Inventory's suspend of a used personal agent writes the same row
  and still logs `agent.status_changed` (noted in `docs/audit-log.md`). `state = suspended` is used
  only on `site_agent_roster` (site admins, site-wide, resumable).
- **Caps:** 200 `active|suspended` entries per roster (checked on assign and on approve) and,
  separately, 200 pending proposals per roster (so proposals can't block builders and vice versa).
  Writes serialize per roster with an advisory lock.
- **Proposals:** approve follows `latest` unless the admin gives `versionRule`; decline stores the
  note on the entry (shown in the owner's Reach), never in the audit row. A removed/declined entry
  is only re-assigned by its owner (POST, row reused in place, `removedAt` kept as history); an
  admin PUT on it is `409 invalid_transition` (or 404 when it could be read as a suspension).
- **Visibility on Team/Site tabs:** removed entries hidden; proposals to proposer/owner/roster
  admins; archived agents to owner and roster admins. Someone else's personal agent shows its
  **version in effect** (name/description from `site_agent_versions`), never the owner's draft; a
  never-published one shows its slug and `not_published`.
- **Delete while rostered (§6.3):** `deleteOrArchiveAgent` gained an optional `beforeDelete`
  guard (2 lines; `refuseIfRostered` in `roster.ts` throws `AgentRosteredError`) run under the
  agent's `FOR UPDATE` lock; roster writes take `FOR SHARE` on the agent, so an
  assignment can't slip in between. `isRostered` scans every team (`scanTeams`): entries outlive
  membership. Only never-published personal agents are affected (published ones archive).
- **Reach** scans every team's roster for the owner's agents (team name included); fine at site
  scale, one query per team.
- **Withdraw from a left team:** `DELETE /v1/agents/:id/assignments/team?teamId=` lets the owner
  withdraw from any team roster the agent is on (membership not required; Reach lists them),
  else a departed owner's agent could never be deleted.
- **Pins on assign:** only the roster's admins (team admin / site admin) may send a numeric
  `versionRule`; anyone else gets `422 version_rule_not_allowed` (owners and builders assign
  following latest). Approve refuses an archived agent (`409 agent_archived`).
- **Site PUT actor:** `SiteRosterActor {userId, siteAdmin}` (no team); `updateEntry` takes
  `RosterActor | SiteRosterActor`.
- **Rate:** one key `agent-roster:<userId>`, 60 per 10 min, for every roster write (assign,
  propose, withdraw, every admin PUT).
- **Audit** (`packages/db/src/audit/events.ts`, documented in `docs/audit-log.md`):
  `agent.roster.{assigned,proposed,approved,declined,pinned,updated,removed,withdrawn,suspended,
resumed}`, target `{agentId, scope, slug, roster}` (+ `versionRule, pinnedVersion` on assigned,
  approved, pinned, updated); `teamId` = the team for team-roster writes, null for site.
- **Email:** not done. The team mailer path needs an outbox table per notification kind
  (egress requests, break-glass); that is a migration, out of scope here → KOBE-570.

## Open for 567/568/569

- **567 (resolution):** use `activeTeamEntries(tx, teamId)`, `activeSiteEntries(db)`,
  `resolvedVersion(entry, currentVersion)` and `teamEntry`/`siteEntry` from `agents/roster.ts`.
  "Suspended here" for any site-wide agent, team entries included, is only
  `team_agent_suspensions` (already checked by run start and pinning); team entries never hold
  `suspended`. Site entries may be `suspended` (site-wide): not runnable anywhere. Bound agents: `site_agents.bound_team_id` (not yet on
  `AgentRecord`; `roster-list.ts` reads it with `SITE_ROW`). Entries of deleted agents are inert:
  skip rows whose agent is missing. Schedules: `paused_by = 'agent_unavailable'` (KOBE-565).
- **568 (fork/transfer/adopt):** `assignDecision` already refuses bound agents outside their team
  (422). Adopt should set the entry `removed` via `writeEntry`-style update + audit (reuse
  `roster-writes.ts`), and the rate key `agent-roster:<userId>` covers transfer too (§6.8).
  `actions.fork` follows §5 but the fork route still uses `canForkAgent` (team → personal refused).
- **569/570 (web):** contract in `@kobe/protocol` `agent-roster.ts`; render buttons from
  `row.actions`. Team-tab "suspend" and Site-tab "suspend here" both call
  `PUT /v1/team/agent-roster/:id {state}`; site-wide suspend is the site PUT. Proposal count:
  rows with `status = proposed` (no separate counter). Inventory columns are not on the rows yet.
- **570 (email):** proposals → admins, decisions → proposer, not sent (see Decisions).

## Open questions (for Chris or the coordinator)

- The protocol contract lands in this feature PR (the brief asks for it here so 569-571 can start).
- Builder assigning someone else's site agent to a team (§5 matrix) vs AR6/AR16 "owner": matrix
  followed; say if only owners should assign.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/agents/roster-access.test.ts` (matrix per role: member, builder,
  team admin, site admin; assign/propose/bound/archived), `src/agent-roster.db.test.ts` (every
  route; 403s per role on team and site PUT; tab reads, paging, cross-team isolation),
  `src/openapi/document.test.ts` (documented = mounted); "review fixes" block (site admin without
  team admin role 403, builder + bound agent 422, pin on assign 422, archived approve 409,
  withdraw from a left team then delete).
- ac-2: `agent-roster.db.test.ts` "a member proposes (202)…", "team admins approve or decline…",
  "site: site admins assign directly…".
- ac-3: `agent-roster.db.test.ts` "caps…", "rate-limits…", "refuses to delete… 409
  agent_rostered", audit assertions in each write test (ids/slug/scope/roster only, no note).

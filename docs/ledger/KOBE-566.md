# KOBE-566: Server: roster read and writes, access rights, audit

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR pending)
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
- **Suspension (§6.5 / AR9), where each mechanism is used:**
  - Team roster, team-assigned entry: `state = suspended` **and** this team's
    `team_agent_suspensions` row (resume clears both). The suspensions row is the one fact run start,
    pinning and `runnable` already check, and it also covers an agent that is both team- and
    site-assigned.
  - Team roster, no team entry: gallery agents and site entries → `team_agent_suspensions` only
    (`{agentId, suspendedHere}` response); team-owned → their `status` (`setAgentStatus`, audited as
    `agent.status_changed` as before).
  - Site roster: site admins `state = suspended` site-wide, resumable. No suspensions row.
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
- **Delete while rostered (§6.3):** `deleteOrArchiveAgent` gained an optional `refuseDelete`
  check run under the agent's `FOR UPDATE` lock; roster writes take `FOR SHARE` on the agent, so an
  assignment can't slip in between. `isRostered` scans every team (`scanTeams`): entries outlive
  membership. Only never-published personal agents are affected (published ones archive).
- **Reach** scans every team's roster for the owner's agents (team name included); fine at site
  scale, one query per team.
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
  A team's suspension of any site-wide agent stays `team_agent_suspensions` (already checked);
  a suspended team entry is not active. Bound agents: `site_agents.bound_team_id` (not yet on
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
  `src/openapi/document.test.ts` (documented = mounted).
- ac-2: `agent-roster.db.test.ts` "a member proposes (202)…", "team admins approve or decline…",
  "site: site admins assign directly…".
- ac-3: `agent-roster.db.test.ts` "caps…", "rate-limits…", "refuses to delete… 409
  agent_rostered", audit assertions in each write test (ids/slug/scope/roster only, no note).

# Kobe — Agents: Personal, Team and Site rosters

Status: **decided by Chris, 2026-11-08** (Q1, Q3 and Q6 explicitly: references with a version
rule, builders assign directly, team-owned agents stay; for the other questions Chris took the
proposed answers, so AR1–AR16 are the decisions). Hadron spec
`4a057ebf-622f-4e43-aa23-7ac7a9e25edb`; tickets filed 2026-11-08: AR-1 KOBE-565, AR-2 KOBE-566,
AR-3 KOBE-567, AR-4 KOBE-568, AR-5 KOBE-569, AR-6 KOBE-570, AR-7 KOBE-571, AR-8 KOBE-572, AR-9
KOBE-573 (lane brief: `docs/ledger/agents-roster-lane.md`). Written 2026-11-08 against main `445af3d9`. Companions:
`docs/specs/agent-creator.md` (the two-tab editor and Dangerous mode, KOBE-476),
`docs/specs/gallery-agents.md` (site admins edit gallery agents, KOBE-494), `docs/agent-versions.md`.

Request (Chris, 2026-11-08): "My Agents" becomes **Agents**. It shows three tabs, **Personal**,
**Team** and **Site**, each a roster of the agents in that scope. With the right permissions a
member can view, edit and fork an agent from any tab. Forks and new agents are always created in
the member's own (Personal) scope; the member then assigns the agent to a team roster or to the
site roster. Suggest what is missing and write the spec.

## 1. Summary

Today an agent's **scope is where its row lives**: `team_agents` (one team, RLS), or `site_agents`
with scope `personal` (one owner, follows them into every team, D9) or `gallery` (repository
seeded, site-admin curated since KOBE-494, read-only to teams, D19/D21). Three pages show them:
My agents (`/me/agents`, personal), Team agents (`/admin/team/agents`, plus the gallery and the
inventory), Gallery (`/admin/site/gallery`). Forks go **into** team or personal scope and copy the
definition.

This spec separates **ownership** from **reach**. An agent is created and edited in exactly one
place, its owner's Personal space; a **roster** is a list that lends it to a team or to the whole
site without copying it:

- **Agents** (`/agents`, replacing `/me/agents`) with tabs **Personal**, **Team**, **Site**. Each
  tab is a roster: who may run which agents from where. Personal: the member's own agents. Team:
  what the active team's members can run, which is team-owned agents (today's `team_agents`) plus
  members' personal agents **assigned** to the team. Site: what every team can run, which is the
  gallery (repository and customized) plus personal agents **assigned** to the site (AR1–AR3).
- One agent, one owner, one editor: an assigned agent is still edited and published by its owner;
  the roster holds a **reference** with a version rule (follow the latest published version, or
  pin one), who assigned it and when (AR4, AR5).
- **Assign** and **withdraw**: builders assign their own personal agents to the team; site admins
  assign to the site; a member without the right **proposes** and an admin approves or declines.
  Team admins and site admins remove any entry; the owner withdraws their own (AR6, AR7).
- **Fork** from any tab makes a new personal agent of the forker's (as asked). To keep teams as
  walls, a fork of a team-owned or team-assigned agent is **bound to that team**: usable and
  assignable there only, never to another team or to the site (AR8).
- View, edit, fork and the other actions follow one permission matrix (§5), server-enforced as
  today (`agentAccess`), extended with roster rights.
- The chat's agent picker, `runnable`, thread pins, schedules, the default agent, suspension,
  archive, delete, export, audit and the admin inventory are reconciled with rosters (§6).
- Suggested additions beyond the request: version rules on roster entries, proposals, transfer and
  adopt for departing owners, per-roster suspension, usage and quality columns, lineage,
  notifications, a team default agent, search and sort (§7).

No change to how a run executes, to policy floors, to Dangerous mode's rules, to version
immutability (D19) or to the agent file format. Two new tables (team roster entries, site roster
entries), both referencing `site_agents`; team-owned agents keep `team_agents` unchanged.

## 2. Where this sits among the Kobe decisions

| Decision                     | How this spec relates to it                                                                                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D6/D8** roles              | Unchanged. `team.agents.use` runs, `team.agents.build` creates team-owned agents and assigns own agents to the team, `team.agents.manage`/`suspend` (team admin) curate the team roster. Site admins (`site.gallery.manage`) curate the site roster. |
| **D9** personal agents       | Kept: a personal agent follows its owner into every team **unless it is team-bound** (AR8). Assignment widens who may run it, never who may edit it.                                                                                                 |
| **D19** versions             | Unchanged: published versions are immutable; threads pin a version. A roster entry names a version rule, never a definition (AR5).                                                                                                                   |
| **D21** gallery              | The gallery becomes part of the Site roster. Repository seeding, Customized, Compare and Reset (KOBE-494) are unchanged; the Site roster adds assigned personal agents beside them (AR3).                                                            |
| **D23** "teams are walls"    | The reason team agents never forked into personal scope. Honoured by binding: a fork of team content is personal but bound to that team (AR8); an assignment to another team or to the site is refused for a bound agent.                            |
| **D29 / AC1** Dangerous mode | Unchanged. A Dangerous agent on a roster runs in Dangerous mode in a team only while its publisher is a site admin or an admin of that team (AC1's per-call check). The roster shows the badge.                                                      |
| **D31** audit                | Roster changes are audited (`agent.roster.*`, §6.9).                                                                                                                                                                                                 |
| **KOBE-122** runnable        | `GET /v1/agents/runnable` becomes roster-driven: the team roster (owned and assigned entries at their resolved version) plus the site roster plus the caller's own personal agents (AR9).                                                            |
| **KOBE-86** inventory        | The team admin's Inventory (usage, suspensions, schedules per agent) becomes the Team tab's admin columns and actions; the page stays reachable until the tab has them all (AR12).                                                                   |
| **KOBE-458** default agent   | Unchanged by default (the gallery agent Kobe). Suggested: a team default chosen from the team roster (§7).                                                                                                                                           |
| **KOBE-180** schedules       | A schedule runs an agent only while its pin is runnable in the team; a roster removal or suspension pauses dependent schedules with a notice (AR11).                                                                                                 |

## 3. Today (what the code does, verified 2026-11-08)

- Tables: `team_agents` (team id, owner user id, definition, revision, `current_version`, archive,
  fork provenance); `site_agents` (scope `personal` with `owner_user_id`, or `gallery` with
  `gallery_key`/`gallery_generation`, Customized marks); `team_agent_versions` and
  `site_agent_versions` (immutable); `team_agent_suspensions` (a team suspends a site-wide agent
  for itself). Caps: team 500, personal 100, gallery 100 live agents.
- Access (`services/server/src/agents/access.ts`): team agents are seen by `team.agents.use`, read
  by builders, edited and published by their creator (any by team admins), suspended by team
  admins; personal agents exist only for their owner; gallery agents are read-only to teams and
  edited by site admins in the Site Console. `canForkAgent` forbids team → personal.
- Routes: `GET/POST /v1/agents` (`scope=team|personal|gallery`), `GET /runnable`, `GET /inventory`,
  `PUT /inventory/:id/status`, `GET/PUT/DELETE /:id`, `GET /:id/export`, `POST /:id/fork`
  (`scope` target), `PUT /:id/status`, versions (`/:id/versions`, `/publish`, `/rollback`,
  `/unarchive`, `/skill-updates`); `/v1/site/gallery/agents/*` for site admins.
- Web: `/me/agents` (list, New agent, the editor at `/me/agents/:id` with eval cases),
  `/admin/team/agents` (list, New agent, editor, cases, evals; Gallery section with Fork to team;
  Inventory), `/admin/site/gallery` (editor, Customized, Compare, Reset). The shared two-tab
  builder (`AgentBuilderPage`, scope `team | personal`) and the gallery editor. Nav: "My agents" in
  the bar, the `/` menu and the command palette.
- Chat: the agent picker lists `runnable` (team, own personal, gallery; active, published, not
  archived, not suspended for this team); the default new-thread agent is the gallery agent Kobe.

## 4. Decisions

**AR1. One page, three rosters.** `/agents` (nav label **Agents**; `/me/agents*` redirects) with
tabs **Personal**, **Team**, **Site** (`?tab=`; the last tab is remembered per browser as the
Skills page does). Every member of the active team sees all three tabs. A roster row shows: icon,
name, Dangerous badge, description, owner (Team and Site tabs), version in effect (`vN`, or
"Draft" for an unpublished own agent), status (Active, Suspended here, Archived, Update
available), updated, and the actions the viewer has (§5).

**AR2. What each roster holds.**

- **Personal:** the member's own agents (`site_agents.scope = personal`, owner = viewer), drafts
  included, with a **Reach** column: Private, Team: X (bound or assigned), Site, Proposed to …
- **Team:** for the active team, (a) team-owned agents (`team_agents`, created before this change
  or by "Create for the team" in §4 AR13) and (b) **assigned** personal agents (`team_agent_roster`).
  A pending proposal shows to its proposer and to team admins as "Proposed".
- **Site:** (a) gallery agents (repository seeded, possibly Customized) and (b) **assigned**
  personal agents (`site_agent_roster`). Pending proposals show to their proposer and to site
  admins.

**AR3. Rosters are references** (decided by Chris, 2026-11-08). A roster entry never copies a
definition. New tables:

| Table               | Columns                                                                                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `team_agent_roster` | `team_id` (RLS, FORCE), `site_agent_id` → `site_agents` (scope personal, NO ACTION), `state` (`proposed`, `active`, `removed`), `version_rule` (`latest` or a pinned version), `assigned_by`, `assigned_at`, `decided_by`, `decided_at`, `note`, `removed_at`; unique (team, agent) |
| `site_agent_roster` | `site_agent_id` (unique), the same state, rule and actor columns; site-wide (no team data), read by every team like the gallery                                                                                                                                                     |

Both tables hold ids and timestamps only (never a definition), as `team_agent_suspensions` does.
Team-owned agents and gallery agents are implicit members of their roster and have no row.

**AR4. One owner, one editor.** Assigning changes nothing about who edits: the owner edits and
publishes in Personal; a team admin or site admin never edits an assigned agent (they remove it,
pin a version, suspend it, or ask the owner). What a team runs is a **published** version only:
a draft can be assigned but is not runnable until published; the roster shows "Not published yet".

**AR5. Version rule** (decided by Chris, 2026-11-08). An entry follows the agent's **latest published version** by default, so
the owner's publish reaches the team at once (threads already started keep their pinned version,
D19). A team admin or site admin can **pin** the entry to a version; a pinned entry behind the
owner's latest shows "Update available" with an **Update** action (to latest, or pick a version).
The owner cannot change another roster's pin. `runnable` and the thread pin resolve the entry's
version, not the agent's.

**AR6. Who assigns.** Assign your own personal agent to the **team** roster: `team.agents.build`
(builders and team admins) directly (decided by Chris, 2026-11-08); a `member` **proposes** and a
team admin approves or declines (`team.agents.manage`). Assign to the **site** roster: site admins directly; anyone else proposes
and a site admin decides. One agent can be on many team rosters and on the site roster at once
(unless bound, AR8). Only published agents can be proposed to the site. Caps: 200 assigned entries
per team roster, 200 on the site roster (the existing agent caps stay).

**AR7. Who removes.** The owner withdraws their agent from any roster (its threads keep their
pins; schedules pause, AR11). Team admins remove any entry from their team's roster; site admins
from the site's. A removed entry keeps its row (`removed`) for the audit trail and can be
re-assigned (back to `active` or `proposed`).

**AR8. Fork lands in Personal, bound when it must.** Fork is offered on every tab to anyone who
may read the definition (§5) and always creates a personal agent of the forker's (fork provenance
as today, from the **published** version of the source, or its draft when it is the forker's own
unpublished agent). `canForkAgent`'s team → personal refusal goes, replaced by **binding**:

- a fork of a team-owned agent or of a team-assigned entry is bound to that team
  (`site_agents.bound_team_id`); so is any fork of a bound agent;
- a fork of a gallery agent, of a site-assigned agent or of an unbound personal agent is unbound;
- a bound agent is runnable, assignable and proposable **in its team only**; "Assign to site" and
  assignment to another team are refused (`422 agent_bound_to_team`); it follows its owner only
  into that team; export of a bound agent is allowed (an export is a deliberate act, as today);
- binding is permanent for that agent (a copy of a copy stays bound); the Personal tab shows
  "Bound to Team X".

**AR9. Runnable set.** In a team a member can run: team-owned active agents, active team roster
entries at their resolved version whose owner is still a member of the team (AR10), site roster
entries at their resolved version, gallery agents, and their own personal agents (bound ones only
in their team). Suspension per team applies to any site-wide entry as today
(`team_agent_suspensions`); team-owned agents keep their `status`.

**AR10. Owner leaves or is deactivated.** A team roster entry whose owner is no longer a member
of the team becomes **Unavailable** (not runnable, shown to team admins with the reason); a site
entry whose owner is deactivated likewise. Threads keep their pinned versions and remain readable.
Team admins and site admins can **Adopt**: the current published version is copied into a
team-owned agent (team) or a new gallery-like site-owned agent (site; `site_agents.scope =
gallery` without a repository key, Customized from the start), with fork provenance, and the
entry is removed. Owners can **Transfer** an agent to another member of the same team beforehand
(the new owner must accept). Deactivated users' personal agents are otherwise unchanged
(`docs/agent-versions.md`).

**AR11. Schedules and threads.** A schedule (KOBE-180) names an agent pin. When the agent leaves
the roster it ran from, is suspended there, or becomes unavailable, the schedule is **paused**
with reason `agent_unavailable` and its owner is told; it resumes when the agent is back. Threads
pinned to a version keep running that version as today; the roster never retroactively changes a
pin.

**AR12. Team admin view.** The Team tab shows admins the Inventory's columns (threads, last used,
schedules, suspension) and actions inline; `/admin/team/inventory` and `/admin/team/agents`
redirect to `/agents?tab=team` once the tab carries them all. Site admins get the Gallery page's
actions (Customized, Compare, Reset, edit) on the Site tab; `/admin/site/gallery` redirects.

**AR13. Creating** (decided by Chris, 2026-11-08: team-owned agents stay). **New agent** on every
tab creates a personal agent (as asked). The Team tab keeps **Create for the team** for builders (a
team-owned agent, today's behaviour), because a team-owned agent outlives its creator's membership
and is what a team wants for shared, long-lived assistants.

**AR14. Editing from a roster.** "Edit" on a Team or Site row opens the owner's editor only for the
owner (and, for team-owned agents, for the rules today: creator or team admin; for gallery agents,
site admins). Everyone else with definition rights gets **View** (read-only definition, versions,
lineage) and **Fork**.

**AR15. Picker and nav.** The chat's agent picker groups by **Personal**, **Team**, **Site** in that
order, each group from the roster, with the Dangerous badge and "Update available" never shown
there. "My agents" becomes "Agents" in the bar, the `/` menu and the command palette; the panel id
stays for stored preferences.

**AR16. API.** `GET /v1/agents?scope=…` stays for the editor; new roster reads and writes:

| Route                                                                                    | Who                                   | Does                                                                             |
| ---------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /v1/agents/roster?tab=personal\|team\|site`                                         | any member (`team.agents.use`)        | the tab's rows with each row's actions for the caller                            |
| `POST /v1/agents/:id/assignments` `{target: team\|site, versionRule?}`                   | owner with the right, else a proposal | `201 active` or `202 proposed`                                                   |
| `PUT /v1/team/agent-roster/:agentId` `{state, versionRule?, note?}`                      | team admin                            | approve, decline, pin, update, remove                                            |
| `PUT /v1/site/agent-roster/:agentId` `{…}`                                               | site admin                            | the same for the site                                                            |
| `DELETE /v1/agents/:id/assignments/:target`                                              | owner                                 | withdraw                                                                         |
| `POST /v1/agents/:id/transfer` `{toUserId}` / `POST …/accept`                            | owner / the new owner                 | transfer                                                                         |
| `POST /v1/team/agent-roster/:agentId/adopt`, `POST /v1/site/agent-roster/:agentId/adopt` | team admin / site admin               | copy into a team-owned or site-owned agent                                       |
| `POST /v1/agents/:id/fork`                                                               | definition readers                    | target is always personal; body keeps `slug?`; `scope` is ignored with a warning |

Every write is audited; every read states the team explicitly on top of `withTeam()`.

## 5. Permission matrix

Rows are the viewer's relation to the agent; columns the actions on a roster row. "Owner" means the
agent's owner (personal) or creator (team-owned). Site admins act on the Site tab regardless of team
role.

| Agent on the tab            | View summary | View definition | Edit / Publish  | Fork    | Assign to team                   | Assign to site                   | Remove from roster             | Suspend here      |
| --------------------------- | ------------ | --------------- | --------------- | ------- | -------------------------------- | -------------------------------- | ------------------------------ | ----------------- |
| Own personal (Personal tab) | owner        | owner           | owner           | owner   | builder: direct; member: propose | site admin: direct; else propose | owner withdraws                | —                 |
| Team-assigned personal      | `use`        | `build`         | owner only      | `build` | —                                | as above (unbound only)          | owner, team admin              | team admin        |
| Team-owned                  | `use`        | `build`         | creator / admin | `build` | n/a (already the team's)         | refused (team content)           | archive (creator / admin)      | team admin        |
| Site-assigned personal      | `use`        | `use`           | owner only      | `use`   | builder (reference, any team)    | —                                | owner, site admin              | team admin (team) |
| Gallery                     | `use`        | `use`           | site admin      | `use`   | n/a (site-wide already)          | n/a                              | n/a (archive by release/admin) | team admin (team) |

A `member` (no `build`) can view and fork what they can read, run what is rostered, and propose
their own agents. Dangerous mode stays admin-only on every path (AC1).

## 6. Details

### 6.1 Data

- `site_agents.bound_team_id uuid null` (AR8; no foreign key to the team, like fork provenance:
  a team can be deleted later; a bound agent of a deleted team is unrunnable and shows "Bound to a
  deleted team"). CHECK: only `scope = personal` rows carry it.
- `team_agent_roster`, `site_agent_roster` (AR3) with RLS on the team table, probe fixtures, and
  the cross-team probe suite green. Indexes on (`site_agent_id`) for the "Reach" column and
  owner-leaves checks.
- `schedules.paused_reason` gains `agent_unavailable` (AR11).
- Migrations: one expand-only schema migration plus RLS, as other team tables.

### 6.2 Resolution

`resolveAgentPin`/`findPinnableAgent` take the roster into account: for a personal agent that is
not the caller's own, it is pinnable in team T when an active entry for (T, agent) or an active
site entry exists, the owner is eligible (AR10), the agent is published, not archived, not
suspended for T; the pinned version is the entry's rule resolved at start. `runnable` lists the
same set; the Personal tab's own agents are pinnable as today (bound ones in their team only).

### 6.3 Archive and delete

Archiving an agent (versions exist) hides it from every roster (entries stay, marked Archived,
not runnable) and from pickers; unarchive restores. Deleting an agent without versions is refused
while it is on a roster or proposed (`409 agent_rostered`); withdraw first.

### 6.4 Proposals

A proposal is an entry in `proposed`. Admins see a count in the tab and a filter; approve pins
`latest` unless they choose a version; decline takes an optional note shown to the proposer. A
proposer may withdraw. Proposals are not runnable. Email to admins and to the proposer on decision
follow the existing notification path (team mailer), with the team's follow-up settings.

### 6.5 Suspension

Team admins suspend any site-wide agent for their team (existing table) and team-owned agents
(status); site admins suspend a site roster entry site-wide (new `state = suspended` on the site
entry, resumable). The roster row says "Suspended here" / "Suspended site-wide".

### 6.6 Versions on the row

"Version in effect" is the resolved version for that roster; a pinned entry shows the pin and
"Update available: vN" when behind. Clicking opens the version history read-only (owner's editor
for the owner). Quality (ratings, eval scorecards) is shown per version as today where the viewer
may read it (`docs/answer-feedback.md`).

### 6.7 Fork

Fork opens a small dialog: name and slug (prefilled), a note "Your copy, in Personal" and, when the
source is team content, "Bound to Team X: usable only there". The copy's draft opens in the editor.
`forkedFromAgentId`/`forkedFromVersion` and `bound_team_id` are recorded; the Personal tab shows
"Forked from <name> vN" with a link to the source where the viewer may see it.

### 6.8 Limits and rates

Assign, propose, decide, withdraw, transfer: 60 per user per 10 minutes. Roster caps (AR6). The
roster read is paginated by (name, id) above 200 rows, like the inventory.

### 6.9 Audit

`agent.roster.assigned`, `.proposed`, `.approved`, `.declined`, `.pinned`, `.updated`,
`.removed`, `.withdrawn`, `.suspended`, `.resumed`, `agent.transferred`, `agent.adopted`,
`agent.forked` (exists: `agent.created` with `source: fork`; gains `boundTeamId`), each with
agent id, slug, scope, actor, and for team entries the team; never a definition.

## 7. Suggested functionality beyond the request

1. **Version rules on roster entries** (AR5): follow latest or pin, with "Update available". Without
   it, an owner's publish silently changes what a team runs, or a team is stuck on an old version.
2. **Proposals** (AR6, §6.4): members without the right can still get an agent in front of a team
   or the site through an admin's decision, like skill promotion today.
3. **Transfer and Adopt** (AR10): an owner's departure should not strand a team on an agent nobody
   can edit; adopt copies it into the team's or the site's ownership.
4. **Per-roster suspension and Unavailable** (AR9–AR11, §6.5): admins can stop an agent for their
   scope without touching the owner's work; schedules pause instead of failing.
5. **Lineage**: "Forked from X vN", and **Compare with source** (the gallery already has Compare
   with the repository) so a forker sees what changed upstream and can re-fork.
6. **Usage and quality columns** on Team and Site: threads this month, last used, ratings and the
   latest eval scorecard per version (the inventory and `agent-quality` already compute them).
7. **Team default agent**: a team admin picks the new-thread default from the team roster
   (today it is always the gallery agent Kobe, KOBE-458); the site default stays the fallback.
8. **Search, filter and sort** on every tab (name, owner, status, Dangerous, Update available),
   remembered per browser.
9. **Notifications** to the owner when their agent is assigned, pinned behind, suspended or
   removed, and to admins for proposals.
10. **Duplicate** in Personal (a fork of your own agent) and **Export / Import** from any tab for
    definition readers (exists per scope today; one place).
11. **Picker grouping** by the same three rosters (AR15), so what a member sees in Agents is what
    the composer offers.
12. **Site roster review** as a light queue for site admins (pending proposals, recently assigned,
    Dangerous agents rostered) in the Site Console, next to the gallery's Customized list.

## 8. Out of scope

Agent marketplaces across installations; agents owned by a team being edited by several teams;
changes to the agent file format, Dangerous mode, policy floors, run execution, or version
immutability; per-member rosters inside a team; renaming team roles.

## 9. Questions and Chris's decisions (2026-11-08)

Chris answered Q1, Q3 and Q6 himself and took the proposed answer for every other question.

1. **Rosters as references (AR3) or as copies?** _References with a version rule._
2. **Default version rule (AR5):** _Follow the owner's latest published version; team and site
   admins may pin an entry._
3. **Who may assign to a team (AR6):** _Builders assign directly; members propose._
4. **Who may assign to the site:** _Site admins directly; everyone else proposes._
5. **Binding (AR8):** _A fork of team content lands in Personal, bound to that team._
6. **Keep team-owned agents (AR13)?** _Yes: "Create for the team" and Adopt (AR10) stay._
7. **Adopt into the site (AR10):** _Yes: a site-owned gallery agent without a repository key,
   Customized from the start._
8. **Transfer (AR10):** _The new owner must accept._
9. **Proposals:** _In this lane, for the team and for the site._
10. **Inventory and Gallery pages (AR12):** _Fold into the tabs; the old pages redirect once the
    tabs carry every action._
11. **Schedules (AR11):** _Pause with a notice (`agent_unavailable`); resume when the agent is back._
12. **Delete while rostered (§6.3):** _Refused (`409 agent_rostered`); withdraw first._
13. **Team default agent (§7.7):** _In this lane, as its own ticket (AR-7)._
14. **Caps:** _200 assigned entries per team roster, 200 on the site roster._
15. **Route and label:** _`/agents`, nav label Agents; `/me/agents*` redirect._
16. **Picker grouping (AR15):** _Personal, Team, Site, in that order._
17. **Bound agents and export:** _Export allowed (a deliberate act, as today)._
18. **Site admins on the Site tab:** _They edit gallery agents there: the Site Console editor's
    actions fold into the tab (AR12)._

## 10. Implementation tickets (filed 2026-11-08 as KOBE-565..573)

| Id (ticket)     | Ticket                                                                                                                    | Depends on |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------- |
| AR-1 (KOBE-565) | DB: `team_agent_roster`, `site_agent_roster`, `site_agents.bound_team_id`, schedule pause reason; RLS, probes, migrations |            |
| AR-2 (KOBE-566) | Server: roster read, assign/propose/decide/withdraw, pin/update, suspend; `agentAccess` roster rights; audit              | AR-1       |
| AR-3 (KOBE-567) | Server: resolution (`runnable`, pins, default agent) roster-driven; owner eligibility; schedules pause/resume             | AR-2       |
| AR-4 (KOBE-568) | Server: fork lands in Personal with binding; transfer; adopt                                                              | AR-2       |
| AR-5 (KOBE-569) | Web: `/agents` with three tabs, rows, actions, redirects, nav rename; Personal reach column                               | AR-2       |
| AR-6 (KOBE-570) | Web: Team admin columns and actions (inventory fold-in), Site admin actions (gallery fold-in), proposals queue            | AR-5       |
| AR-7 (KOBE-571) | Web: fork dialog, lineage, version rule UI, picker grouping                                                               | AR-4, AR-5 |
| AR-8 (KOBE-572) | Browser specs on gate1: assign and run from another member; propose and approve; fork bound; pin and update; owner leaves | AR-3..7    |
| AR-9 (KOBE-573) | Docs: agents roster guide, permission matrix in `docs/`, audit-log rows                                                   | AR-8       |

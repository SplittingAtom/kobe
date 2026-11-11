# Agents: Personal, Team and Site rosters

Member guide: [Agents](guide/agents/agents.md). This page is the reference for rosters, rights and the API.

Kobe separates who **owns** an agent from who may **run** it. An agent is created and edited in
one place; a **roster** lends it to a team or to the whole site by reference, without copying it.
This page describes the shipped behaviour (KOBE-565..572, spec `docs/specs/agents-roster.md`).
Published versions, archive and erasure are in [agent-versions.md](agent-versions.md); the audit
events are in [audit-log.md](audit-log.md).

Roles below: **member**, **Contributor** (`team.agents.build`, called "builder" in the spec; renamed
by the Workspaces lane), **team admin** (`team.agents.manage`, `team.agents.suspend`) and **site
admin** (site role Owner or Admin, `site.gallery.manage`).

## The Agents page

`/agents` (nav label **Agents** in the bar, the `/` menu and the command palette) has three tabs,
**Personal**, **Team** and **Site** (`?tab=personal|team|site`; without it the last tab used in this
browser, else Personal). Every member sees all three tabs. Old addresses redirect (307):

| Old address           | Goes to                |
| --------------------- | ---------------------- |
| `/me/agents`          | `/agents?tab=personal` |
| `/me/agents/<path>`   | `/agents/<path>`       |
| `/admin/team/agents`  | `/agents?tab=team`     |
| `/admin/site/gallery` | `/agents?tab=site`     |

The two console list pages redirect on their exact paths only: the team builder (`/admin/team/agents/new`, `/:id`, cases) and
the gallery editor (`/admin/site/gallery/:id`) stay where they were. `/admin/team/inventory` stays as
the team's Skills and Connectors inventory; its Agents section points at the Team tab.

What each tab holds:

| Tab      | Rows                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Personal | Your own personal agents, drafts included, with a **Reach** column                                                                       |
| Team     | The active team's team-owned agents, plus members' personal agents **assigned** to the team roster                                       |
| Site     | Gallery agents (repository seeded or Customized, and agents adopted into the site), plus personal agents **assigned** to the site roster |

A row shows the name, Dangerous badge, description, owner (Team and Site), **Version in effect**,
status and the actions the server says the viewer has (`row.actions`; the page derives no rights of
its own). Someone else's personal agent is always shown at its version in effect, never the owner's
draft.

| Status                    | Meaning                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Active                    | Runnable here                                                                                              |
| Proposed                  | A pending proposal; shown only to its proposer and the roster's admins                                     |
| Draft / Not published yet | Never published: assignable to a team, not runnable ("Draft" on your own Personal row)                     |
| Suspended here            | This team suspended it                                                                                     |
| Suspended site-wide       | A site admin suspended its site entry                                                                      |
| Unavailable: …            | Its owner left the team (team entry) or was deactivated (either roster); shown only to the roster's admins |
| Archived                  | The agent was archived; shown only to its owner and the roster's admins                                    |

The Personal tab's **Reach** column lists where each agent goes: Private; Bound to Team: X; Team: X;
Site; "(suspended)" after a suspended entry; Proposed to X; Declined for X (with the admin's note
when one was given). An entry on the roster of a team you have left carries a **Withdraw** button.

For team admins the Team and Site tabs add the old Inventory's columns: Runs, Last run, Tokens,
Schedules (with their paused reason) and Orbit score, plus **Export to Orbit**. On the Site tab site
admins also get the Gallery page's actions: Customized badge, Compare and Reset to repository
notices, Edit, Run eval… and Export file.

## Creating

Moved to the member guide: [Agents](guide/agents/agents.md).

## Rosters are references

A roster entry holds ids and timestamps only, never a definition: the agent, its state (`proposed`,
`active`, `removed`, and on the site roster `suspended`), a **version rule**, who assigned it and
when, who decided and when, and an optional note. Team-owned agents and gallery agents belong to
their roster implicitly and have no entry. Tables: `team_agent_roster` (RLS, one row per team and
agent) and `site_agent_roster` (site-wide, one row per agent). Neither has a foreign key to
`site_agents`; an entry of a deleted agent is inert.

The owner stays the only editor: assigning an agent changes who may run it, never who may edit it.
Admins remove, pin, suspend or adopt an entry, but cannot edit the agent.

### Version rule

An entry follows the agent's **latest published version** by default, so the owner's publish reaches
the roster at once. A roster's admins (team admins for the team roster, site admins for the site)
can **pin** an entry to a published version ("Pin a version…"). A pinned entry behind the owner's
latest shows **Update available: vN** and offers **Update to latest (vN)** or another version. The
owner cannot change another roster's pin, and only a roster's admins may send a pinned version when
assigning (anyone else gets `422 version_rule_not_allowed`).

Threads pin a version when they start (D19). Changing a rule, removing an entry or suspending it never
changes an existing thread's pin: that thread keeps running its version.

### Assign, propose, decide

The row menu offers **Assign to <team>** or **Propose to <team>**, and **Assign to the site** or
**Propose to the site** (`POST /v1/agents/:id/assignments`; `201` for an active entry, `202` for a
proposal):

| Target      | Assigns directly                                                                                                        | Proposes                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Team roster | The owner if a Contributor or team admin; a Contributor may also add someone else's **site-assigned** agent to the team | The owner if a member                                                   |
| Site roster | The owner if a site admin                                                                                               | Any other owner (published agents only, else `422 agent_not_published`) |

A draft can be assigned to a team but is not runnable until published. One agent can be on many team
rosters and on the site roster at once, unless it is bound (see [Fork and binding](#fork-and-binding)).

Proposals: deciders (team admins on the Team tab, site admins on the Site tab) get a **Proposed (n)**
toggle above the table that filters the rows to pending proposals. **Approve…** follows the latest
version unless the admin picks a pin; **Decline…** takes an optional note, shown to the proposer in
their Reach column and never written to the audit log. Proposals are not runnable. No email is sent
for proposals or decisions.

### Withdraw and remove

The owner withdraws their agent or proposal from any roster (**Withdraw from <team>**, **Withdraw
from the site**; `DELETE /v1/agents/:id/assignments/team|site`, `?teamId=` for a team they have
left). A roster's admins **Remove** any assigned entry. A removed entry keeps its row for the audit
trail; only the owner can put it back (assign or propose again).

## What a team runs

In a team a member can run: team-owned active agents; active team roster entries at their resolved
version, while the owner is still a member of the team and not deactivated; site roster entries at
their resolved version, while the owner is not deactivated; gallery agents; and their own personal
agents (bound ones only in their team). A team's suspension (`team_agent_suspensions`) and a site-wide
suspension of a site entry make an agent not runnable; a site-wide suspension wins over an active
team entry.

`GET /v1/agents/runnable`, thread pins, agent switches in a thread and schedules all resolve through
the same rules. The chat's agent picker groups the runnable agents as **Personal** (your own),
**Team** (team-owned and team entries) and **Site** (gallery and site entries).

**View** on a Team or Site row opens a read-only builder at `/agents/:id` showing the version in
effect ("You're viewing vN, the version this roster runs"), its versions and quality, for anyone who
may read the definition (see the matrix). `?from=site` makes the Site entry the source when the agent
is on both rosters. Someone else's never-published agent cannot be viewed.

### Team default agent

A team admin chooses the team's default agent for new conversations in the team console (**Agents and
skills → Default agent**, `/admin/team/default-agent`; `GET`/`PUT /v1/team/default-agent`). The
options are team-owned agents, active team entries, site entries and gallery agents that are
published and active here. The choice is stored in `teams.settings`; if it stops being runnable for a
member, that member's new threads fall back to the site default (Kobe). Audited as
`team.default_agent_changed`.

## Fork and binding

**Fork to Personal…** is offered on every tab to anyone who may read the definition. It opens a dialog
(name and slug prefilled) and always creates a personal agent of the forker's, from the source's
**published** version (or the draft of your own never-published agent), with fork provenance. A member
without `team.agents.build` cannot fork team content.

To keep teams as walls, some forks are **bound** to a team (`site_agents.bound_team_id`):

- a fork of a team-owned agent or of a team-assigned entry is bound to the active team;
- a fork of a bound agent stays bound to the same team (binding is permanent);
- a fork of a gallery agent, of a site-assigned agent or of your own unbound agent is unbound (when an
  agent is on both the site and the team roster, the site entry wins and the copy is unbound).

A bound agent is runnable, assignable and proposable only in its team; assigning it to the site or to
another team, transferring it to someone outside that team, and adopting it into the site or another
team are refused with `422 agent_bound_to_team`. Export of a bound agent is allowed. The dialog says
"Bound to Team X: usable only there." and the Personal row shows "Bound to Team: X".

Personal rows show lineage, "Forked from <name> vN" (or "an agent you can't see" when the source is
not readable from the active team), and **Compare with source**, which shows the source version's
instructions beside your copy's draft.

## Transfer and adopt

**Transfer** (API only; there is no web UI yet): the owner offers a personal agent to another active
member of the active team (`POST /v1/agents/:id/transfer {toUserId}`). The recipient must accept
(`POST /v1/agents/:id/transfer/accept`); either side can cancel or decline (`DELETE
/v1/agents/:id/transfer`); `GET /v1/agents/transfers` lists offers in both directions. One pending
offer per agent site-wide: a new offer in the same team replaces the old one, an offer pending in
another team must be cancelled first. Accepting re-checks membership, binding, the recipient's slug
(`409 slug_taken`) and agent cap (`409 limit_reached`), then moves the owner only: the agent keeps
its id, roster entries keep their rows and threads keep their pins. Archived agents cannot be
transferred (`409 agent_archived`).

**Adopt**: a roster's admins (team admins on the Team tab, site admins on the Site tab) can **Adopt
into <roster>** any assigned entry, whether or not its owner is still there. Adopt copies the agent's
**current published version** (not the entry's pin) into a new agent and publishes it as v1 in the
same transaction, then removes the entry:

- team roster: a team-owned agent, with the adopting admin as its creator;
- site roster: a site-owned gallery agent without a repository key (the seed never touches it).

The original personal agent is unchanged. This is how a team keeps an agent whose owner left
(Unavailable rows); the owner can instead transfer it beforehand.

## Suspension, archive and delete

- **Suspend here / Resume here** (team admins): on the Team tab for team-owned agents (their own
  status) and team entries; on the Site tab for gallery agents and site entries. Everything but a
  team-owned agent uses the team's `team_agent_suspensions` row; a team entry's own state stays
  `active`.
- **Suspend site-wide / Resume site-wide** (site admins, Site tab): the site entry's state
  `suspended`; not runnable in any team.
- **Archive**: an archived agent is hidden from pickers and not runnable; its entries stay, marked
  Archived for the owner and admins. Approving a proposal of an archived agent is refused (`409
agent_archived`).
- **Delete**: a never-published personal agent cannot be deleted while it is on any roster or proposed
  (`409 agent_rostered`); withdraw it first. Published agents archive instead of deleting, as before.

## Schedules

A schedule names an agent pin. When a schedule's agent (someone else's lent agent, or a gallery agent)
can no longer start a thread for the schedule's owner, because it was withdrawn or removed, suspended
here or site-wide, or became Unavailable, the schedule is paused with `schedules.paused_by =
'agent_unavailable'` and its owner gets the in-app `schedule.paused` notification ("Paused: agent
unavailable"). It resumes by itself once the agent is runnable again (checked on roster writes,
member removal and every scheduler tick); until then the owner cannot resume it (`422
agent_not_runnable`). Pause and resume are audited as `schedule.deactivated` / `schedule.activated`
with `by: agent_unavailable` / `agent_available`.

## Permission matrix

Rows are the viewer's relation to the agent on the tab; columns the actions on its row. "Owner" means
the personal agent's owner or the team-owned agent's creator. Site admins act on the Site tab
regardless of their team role. `use` = any member, `build` = Contributor or team admin. The server
enforces this on every write (`rosterActions` and `assignDecision` in
`services/server/src/agents/access.ts`).

| Agent on the tab            | View summary | View definition | Edit / Publish  | Fork    | Assign to team                       | Assign to site                   | Remove from roster             | Suspend here      |
| --------------------------- | ------------ | --------------- | --------------- | ------- | ------------------------------------ | -------------------------------- | ------------------------------ | ----------------- |
| Own personal (Personal tab) | owner        | owner           | owner           | owner   | Contributor: direct; member: propose | site admin: direct; else propose | owner withdraws                | —                 |
| Team-assigned personal      | `use`        | `build`         | owner only      | `build` | —                                    | as above (owner, unbound only)   | owner, team admin              | team admin        |
| Team-owned                  | `use`        | `build`         | creator / admin | `build` | n/a (already the team's)             | refused (team content)           | archive (creator / admin)      | team admin        |
| Site-assigned personal      | `use`        | `use`           | owner only      | `use`   | Contributor (reference, any team)    | —                                | owner, site admin              | team admin (team) |
| Gallery                     | `use`        | `use`           | site admin      | `use`   | n/a (site-wide already)              | n/a                              | n/a (archive by release/admin) | team admin (team) |

Also: pin, approve, decline and adopt belong to the roster's admins (team admins, site admins); a
member can view and fork what they can read, run what is rostered, and propose their own agents.
Dangerous mode stays admin-only on every path (AC1).

## API

| Route                                                               | Who                                  | Does                                                                                          |
| ------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `GET /v1/agents/roster?tab=personal\|team\|site[&cursor&limit]`     | any member                           | The tab's rows with each row's actions; pages of up to 200 by (name, id)                      |
| `POST /v1/agents/:id/assignments` `{target, versionRule?}`          | owner, or a Contributor by reference | `201` active entry or `202` proposal                                                          |
| `DELETE /v1/agents/:id/assignments/:target[?teamId=]`               | owner                                | Withdraw                                                                                      |
| `PUT /v1/team/agent-roster/:agentId` `{state, versionRule?, note?}` | team admin                           | Approve, decline, pin, update, remove; suspend or resume here                                 |
| `PUT /v1/site/agent-roster/:agentId` `{state, versionRule?, note?}` | site admin                           | The same for the site roster; `suspended` is site-wide                                        |
| `POST /v1/team/agent-roster/:agentId/adopt`                         | team admin                           | Adopt into a team-owned agent                                                                 |
| `POST /v1/site/agent-roster/:agentId/adopt`                         | site admin                           | Adopt into a site-owned gallery agent                                                         |
| `POST /v1/agents/:id/transfer` `{toUserId}`, `…/transfer/accept`    | owner / recipient                    | Offer, accept                                                                                 |
| `DELETE /v1/agents/:id/transfer`, `GET /v1/agents/transfers`        | owner or recipient                   | Cancel or decline; list                                                                       |
| `POST /v1/agents/:id/fork` `{slug?, name?}`                         | definition readers                   | Always a personal copy; a `scope` field is ignored with a warning; response has `boundTeamId` |
| `GET` / `PUT /v1/team/default-agent`                                | member / team admin                  | Team default agent                                                                            |

`versionRule` is `"latest"` or a version number. Every roster write, transfer and adopt counts against
one rate limit, 60 per user per 10 minutes (`429 rate_limited`). Caps: 200 assigned entries per
roster (`active` or `suspended`) and, separately, 200 pending proposals per roster (`409
roster_limit`).

| Error                                                                                                                        | Status |
| ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| `invalid_request`                                                                                                            | 400    |
| `forbidden`                                                                                                                  | 403    |
| `agent_not_found`, `roster_entry_not_found`, `version_not_found`, `transfer_not_found`                                       | 404    |
| `agent_archived`, `already_on_roster`, `invalid_transition`, `roster_limit`, `agent_rostered`, `slug_taken`, `limit_reached` | 409    |
| `agent_bound_to_team`, `agent_not_published`, `version_rule_not_allowed`, `transfer_recipient_invalid`                       | 422    |
| `rate_limited`                                                                                                               | 429    |

Someone else's agent that is not on a roster you can read answers `404`, never `403`, so the API does
not reveal that it exists.

## Audit

Roster writes record `agent.roster.assigned`, `.proposed`, `.approved`, `.declined`, `.pinned`,
`.updated`, `.removed`, `.withdrawn`, `.suspended` and `.resumed`; transfers record
`agent.transfer.requested`, `agent.transfer.cancelled` and `agent.transferred`; adopt records
`agent.roster.removed`, `agent.created` (`source: adopt`), `agent.published` and `agent.adopted`; a
fork records `agent.created` (`source: fork`, with `boundTeamId`). Team roster events carry the team;
site roster events are site-only. Fields: [audit-log.md](audit-log.md#event-taxonomy-and-field-allowlist).

## Not built yet

These parts of the spec are not in the shipped code: a web UI for transfers; email to admins about
proposals and to proposers about decisions (and email for `schedule.paused`); search, filter and sort
on the tabs (beyond the Proposed filter); notifications to owners when their agent is assigned, pinned
behind, suspended or removed; a "Bound to a deleted team" label (such a row shows "another team").
Agents a team's threads used but that are on no roster no longer appear anywhere for admins (the old
Inventory page listed them).

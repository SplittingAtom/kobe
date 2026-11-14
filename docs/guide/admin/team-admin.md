---
title: Team admin overview
summary: What team admins and contributors can do, and where each setting lives in the Team console (members, memory stewards, models, budgets, connectors, egress, memory curation with import and export, policy, agents and skills).
section: Team admin
order: 1
audience: admin
---

Each workspace is run by its team admins. They manage who is in the team, which models,
connectors and websites it can use, what its agents may do without asking, and how long it keeps
its data. This page is a map of the **Team console** for team admins, and of what contributors
can do.

## Roles in a team

| Role            | Can                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| **Member**      | Chat, use the team's agents, skills and connectors, read every project, keep personal files and memory. |
| **Contributor** | Everything a member can, plus build and publish team agents, publish team skills and create projects.   |
| **Team admin**  | Everything, plus run the Team console.                                                                  |

A workspace always has at least one team admin: the last one cannot be removed or demoted.
**Memory steward** is not a role but a grant on top of any of these roles (see below).
Contributors and members get no rights over the workspace's shared memory from their role. Project
roles (owner, editor, reader) are separate; team admins can do everything in every project. See
[Workspaces, My files and projects](../files/workspaces-and-projects.md).

## Open the Team console

Team admins see **Team console** on the rail's top line (`/admin/team`). It acts on the active
workspace; switch workspace first to manage another.

## Team

- **Members and roles**: who is in the team; change a role or remove a member. A removed member's
  checkouts are discarded and their sandbox is cleaned up. A member a site admin added from the
  Site console shows **Added by a site admin** under Joined; site admins can also change roles and
  remove members there. You are told each time (a notification naming the site admin and the
  member, and an email when mail is set up), and every such change is in **Audit** under the site
  admin's name, marked as made by a site admin. Team admins add people by invitation only.
- **Members managed by the identity provider**: with single sign-on, a membership that comes from
  your organization's app roles or groups shows **Managed by _provider_** under Role. You can't
  change its role or remove it here (the site refuses with "The identity provider manages this
  membership"): to take someone's access away, have them removed from the app role or group at
  the provider. **Take over** makes the membership the team's own after a confirmation; from then
  on only team admins change it, even when the person's access at the provider changes. Another
  team admin takes over your own membership. **Show access mappings** lists the provider's
  mappings that target this team (read-only; site admins edit them). See
  [Single sign-on](single-sign-on.md#access-mappings).
- **Memory stewards** (on **Members and roles**): members who curate the workspace's shared
  memory together with team admins: they add, edit, archive and pin **Workspace memories**, the
  facts and conventions every member's agent can use. Any member can be a steward, whatever their
  role. Choose a member under **Make a memory steward**; **Take memory steward** ends it after a
  confirmation (what they saved stays). Stewardship ends when the person leaves the workspace.
  Stewards open only the console's **Memory** page (see [Workspace memories](#workspace-memories));
  they can't send memories to the Site, change the memory switches, or do anything else a team
  admin does. Every grant and every removal is in **Audit** (`memory.steward.granted`,
  `memory.steward.revoked`).
- **Invitations**: invite people by email; they join when they accept.

## Workspace settings

| Page                    | What you set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Models**              | Which models from the site catalog the team may use, and the team default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Budgets**             | Daily or monthly dollar budgets for the team, a default member budget, and budgets per member.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Connectors**          | Enable registered connectors and choose each one's exposure; set the built-in **Kobe** connector's level.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Egress**              | Enable domains within the site ceiling, answer access requests, and inject headers for a domain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Policy**              | Team deny, ask and allow rules inside the site floor, remember limits, and members' remembered approvals.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Memory**              | **Memories**: the workspace's memories, Site memories and Site Policy (see [Workspace memories](#workspace-memories)). **Import and export**. **Settings**: the workspace's memory switches (memory, project notes, memories, Workspace memories, Site memories in this workspace's runs, Learn from this chat, proposing to the Site; each also needs the site's switch; off deletes nothing; Site Policy applies whatever you set) and the workspace's learning model, with which model Learn uses now. See [Memory](../memory.md#switches-that-control-memory). |
| **Retention**           | How long the team keeps threads, within the site maximum.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Storage and history** | Bytes and objects per workspace and project, the object budget, and how long project history is kept; limits in [Storage limits](../files/storage-limits.md).                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Follow-ups**          | Suggest three follow-up messages after each answer (a short model call per run).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Workspace memories

The **Memory** page's **Memories** tab is for the workspace's curators: team admins and memory
stewards. Anyone else who opens it reads only.

- **List and filters**: one scope at a time (**Workspace memories**, or **Site memories**, which
  you read but don't change here), filtered by kind, status (active, archived, superseded) and
  tag. The tag filter matches the memories loaded so far; **Show more** loads more.
- **Add, edit, archive, restore, pin and tags**: every save runs the same checks as everywhere
  else (secrets are refused, instruction-like text, personal data, unreachable links and
  near-duplicates are warnings you can save over, a contradiction of Site Policy needs **Save
  anyway**, which is recorded). Every change has **Undo**. A notice appears when the workspace
  holds 80% of its limit, and another when it is full.
- **Site Policy**: the Policy text every agent in the workspace is given in every run, read-only.
  Only Site admins change it.

**Import and export** (curators):

- **Import**: paste or choose Markdown bullets (`- [fact] Invoices go out on the 1st #billing`:
  the kind in brackets, tags at the end), a CSV with the columns `statement,kind,tags,pinned`
  (tags separated by `;`), or a Kobe export file, at most 200 rows. **Preview** checks every row
  with the save checks above and stores nothing; each row says what it is: **New**,
  **Near-duplicate**, **Conflicts with Policy**, **Blocked by Policy rules** (for example a
  Policy row outside the Site), **Secret: never saved**, **Flagged by checks** or **Can't be
  imported** (unreadable, or memories turned off). No model reads the file. A row holding a
  secret is never shown back, whatever else is wrong with it. **Import** saves the new rows only, all at once; add the
  others one by one, where you can save over a warning. If anything changed since the preview,
  nothing is saved and Kobe asks you to preview again. Archived rows in a file count against the
  workspace's limit like active ones. Imports and exports are limited per person per minute.
  Imports are audited (`memory.items.imported`, counts only).
- **Export**: the workspace's memories as JSON (a Kobe export, which imports again as it was) or
  CSV, optionally with archived and superseded ones. Statements, kinds, tags and pins only; never
  who wrote them or the conversations they came from. Every export is audited
  (`memory.items.exported`).

Each registered connector on the **Connectors** page lists its tools in two columns with counts:
**Read only** (tools that declare themselves read-only) and **Write** (every other tool, including
one that declares nothing, which Kobe treats as able to change data). The exposure still decides
what the team gets: while the saved exposure is **Read-only tools**, the Write column's tools are
marked **Not offered to the team**; choosing **Read-only tools** without saving marks them **Would
not be offered under Read-only tools**. A tool only an app may call (not the agent) is marked
**Not offered (app only)** under every exposure and cannot be ticked. Under **Chosen tools**, tick
tools in either column. On a narrow window the columns stack. A tool changed upstream shows
**Unavailable** until a site admin approves it again. A tool that opens an app card (an MCP Apps
`ui://` template) carries an **MCP-UI** badge; hover or focus it to see the template and whether a
site admin has approved it (an app that is not approved yet does not open).

The **Kobe** card on the **Connectors** page sets what agents may do with Kobe's own admin tools
in this team: **Docs only** (the default), **Read** or **Read and write**. Agents always have the
docs tools. Admin tools act as the person in the conversation, within that person's permissions,
and every change asks them first. It works only while a site admin allows admin tools. See
[Admin from a conversation](admin-from-a-conversation.md).

Header injection on the **Egress** page adds a header, such as an API token, to requests the
proxy forwards to that domain, so the secret never enters a sandbox. Values are not shown again
after saving.

## Agents and skills

- **Team agents**: the team's roster on the Agents page (Team tab): approve or decline proposals,
  pin versions, suspend agents, see usage, and **Adopt into _team_** to make a member's assigned
  agent team-owned (see [Agents](../agents/agents.md#adopt-an-agent-into-a-roster)).
- **Default agent**: the agent new conversations start with.
- **Agent evaluation**: run a safety evaluation before agents publish, and set the allowed attack
  rate.
- **Inventory**: the team's skills and connectors.
- **Schedules**: every member's scheduled runs; pause one, or resume one a team admin paused.
- **Skills**: access modes (required, on by default, available, hidden), the agents they reach and
  catalog installs.
- **Skill review**: approve or reject scanned skill versions; switch personal skills off for the
  team. No run uses a new team skill version until you approve it, and the same goes for a
  member's personal skill whose scan is not Pass. Pending versions are left out without a warning,
  so check the queue when a member says a skill does not load.

## Governance

- **Audit view**: the team's audit events.
- **Usage**: spend by user, agent and model.
- **Break-glass access**: when site admins had time-boxed, read-only access to this team, now and
  in the past. A banner tells members while it is active.

## From a conversation

With the Kobe connector at **Read and write**, most of this console can also be run by asking the
agent: change a role, send an invitation, approve a skill version, enable a domain, pause a
schedule, read usage or the audit log. Each change shows an **Admin change** card first and is
audited as you "via agent". Break-glass, retention, deletions, injected headers and the Kobe level
itself stay in the console. See [Admin from a conversation](admin-from-a-conversation.md).

## What team admins cannot do

Team admins cannot approve tool calls for someone else, read members' private conversations or My
files, see members' connector keys, or go beyond the site's ceilings (models, egress, policy floor,
retention maximum). Those are set in the [Site console](site-admin.md).

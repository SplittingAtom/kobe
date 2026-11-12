---
title: Team admin overview
summary: What team admins and contributors can do, and where each setting lives in the Team console (members, models, budgets, connectors, egress, memory, policy, agents and skills).
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

A workspace always has at least one team admin: the last one cannot be removed or demoted. Project
roles (owner, editor, reader) are separate; team admins can do everything in every project. See
[Workspaces, My files and projects](../files/workspaces-and-projects.md).

## Open the Team console

Team admins see **Team console** on the rail's top line (`/admin/team`). It acts on the active
workspace; switch workspace first to manage another.

## Team

- **Members and roles**: who is in the team; change a role or remove a member. A removed member's
  checkouts are discarded and their sandbox is cleaned up.
- **Invitations**: invite people by email; they join when they accept.

## Workspace settings

| Page                    | What you set                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| **Models**              | Which models from the site catalog the team may use, and the team default.                                |
| **Budgets**             | Daily or monthly dollar budgets for the team, a default member budget, and budgets per member.            |
| **Connectors**          | Enable registered connectors and choose each one's exposure; set the built-in **Kobe** connector's level. |
| **Egress**              | Enable domains within the site ceiling, answer access requests, and inject headers for a domain.          |
| **Policy**              | Team deny, ask and allow rules inside the site floor, remember limits, and members' remembered approvals. |
| **Memory**              | Allow memory, and allow project memory (both also need the site switch).                                  |
| **Retention**           | How long the team keeps threads, within the site maximum.                                                 |
| **Storage and history** | Bytes and objects per workspace and project, the object budget, and how long project history is kept.     |
| **Follow-ups**          | Suggest three follow-up messages after each answer (a short model call per run).                          |

Each registered connector on the **Connectors** page lists its tools in two columns with counts:
**Read only** (tools that declare themselves read-only) and **Write** (every other tool, including
one that declares nothing, which Kobe treats as able to change data). The exposure still decides
what the team gets: under **Read-only tools**, the Write column's tools are marked **Not offered
to the team**; under **Chosen tools**, tick tools in either column. On a narrow window the columns
stack. A tool changed upstream shows **Unavailable** until a site admin approves it again. A tool
that opens an app card (an MCP Apps `ui://` template) carries an **MCP-UI** badge; its tooltip names
the template and whether a site admin has approved it (an app that is not approved yet does not
open).

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
  pin versions, suspend agents, see usage.
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

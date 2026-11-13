---
title: Agents
summary: How to pick an agent for a conversation, browse the Personal, Team and Site rosters, create and publish your own agent, choose how much memory it uses, and schedule it.
section: Agents and skills
order: 1
audience: member
---

An agent is a configured assistant: a system prompt, a model, skills, connectors, allowed and
denied tools and an approval mode. Every conversation runs one agent; if you pick none, it runs your
team's default agent. This page shows how to choose, find, create and schedule agents.

## Pick an agent for a conversation

The agent picker in the composer's toolbar lists the agents you can run here, grouped as
**Personal** (your own), **Team** (the team's agents and agents assigned to the team) and **Site**
(gallery agents and agents assigned to the whole site). A thread keeps the agent version it started
with, even if the agent is updated later.

## The Agents page

**Agents** in the top bar (`/agents`) has three tabs:

| Tab          | Shows                                                                                 |
| ------------ | ------------------------------------------------------------------------------------- |
| **Personal** | Your own agents, drafts included, with a **Reach** column saying where each one goes. |
| **Team**     | The team's own agents, plus members' agents assigned to the team.                     |
| **Site**     | Gallery agents, plus agents assigned to the whole site.                               |

Each row shows the name, description, owner, **Version in effect**, status and the actions you
have. **View** opens a read-only copy of the version a roster runs. Statuses include **Active**,
**Proposed**, **Draft**, **Suspended here** (the team suspended it) and **Suspended site-wide**.
An agent marked **Dangerous** runs its allowed tools without asking (see below).

## Create an agent

**New agent** on any tab creates a personal agent, which only you can edit. On the Team tab,
contributors also get **Create for the team**: a team-owned agent that outlives its creator's
membership, edited by its creator or a team admin.

The builder has two tabs, **Identity** and **Behaviour**:

- **Identity**: **Name**, **Slug**, **Description** (one line on what it is for), an icon, the
  **System prompt** ("What the agent is told at the start of every conversation") and up to eight
  **Conversation starters**.
- **Behaviour**: **Model**, **Skills** (with "Use only the listed skills"), connectors (all the
  team enables, or chosen ones), **Allowed tools** and **Denied tools**, and **Approval mode**:
  **Ask on write**, **Ask for every tool** or **Auto (allow-listed tools only)**. The mode is never
  looser than the team's floor.

**Save draft** keeps your changes; **Test chat** tries the draft without publishing. **Publish…**
creates a new version, after a safety check. Each published version is kept in **Version history**.

### Memory

The builder's **Memory** section sets how much memory the agent uses, per published version:

| Setting        | What the agent gets                                                                      |
| -------------- | ---------------------------------------------------------------------------------------- |
| **All memory** | Memory notes (My memory, project memory) and any other memories Kobe keeps. The default. |
| **Notes only** | Memory notes only.                                                                       |
| **Off**        | No memory at all: no memory index, no **remember** or **recall** tools.                  |

The agent always uses the memory of the person running it, never yours: sharing an agent never
shares your memory. **Save as a new version** publishes the current version again with the new
setting (the draft is untouched), so threads keep their version and rosters that follow your latest
version get it. The new version shows **Not evaluated** in Version history: memory changes how
the agent behaves, so evaluate it again before relying on its old score. Publishing the draft keeps
the current setting; restoring a version restores its setting (the confirmation says when that
changes memory). An adopted copy keeps the setting of the version it copied; a fork starts at
**All memory**. A **Test chat** uses the current version's setting. Site admins set it the same way
for gallery agents. Team and site memory switches still apply on top: an agent set to **All
memory** has none where memory is switched off.

**Dangerous** mode ("allowed tools run without asking") can only be set by team and site admins. It
applies only to tools named one by one in Allowed tools, and only in interactive conversations;
deny rules and the team's ask rules still apply.

## Share an agent with a team or the site

A roster lends an agent to a team or the whole site without copying it; you stay the only editor.
From your agent's row menu:

- **Assign to _team_** (contributors and team admins) or **Propose to _team_** (members; a team
  admin approves or declines).
- **Assign to the site** (site admins) or **Propose to the site** (anyone, for a published agent).

A roster follows your latest published version unless its admins pin one. **Withdraw from _team_**
or **Withdraw from the site** takes it back. The Reach column shows where it went, including
"Declined for _team_" with the admin's note.

## Schedule an agent

A schedule sends a prompt to one of your agents at set times; its runs appear as conversations.
Open **My schedules** (`/me/schedules`) and press **New schedule**: pick the **Agent**, write the
**Prompt**, choose how it **Repeats** (or a cron expression) and the time zone, and optionally
**Email me when a run ends**. Each schedule can be edited, paused, resumed or deleted; one a team
admin paused can only be resumed by a team admin. Scheduled runs cannot stop to ask you, so
a tool call that would need approval is skipped instead; remembered approvals do not apply there.
A team admin who wants a tool to run unattended adds a team allow rule.

## Related

- [Skills](skills.md)
- [Approvals](../internet-and-approvals/approvals.md)
- [Models and thinking levels](../models.md)

---
title: Skills
summary: What skills are, how to turn them on, and how to write, test, save and promote a skill in the Workbench, including the kobe.skill.yaml file.
section: Agents and skills
order: 2
audience: member
---

A skill teaches an agent how to do one kind of task: a `SKILL.md` with instructions, plus any
scripts, references or assets it needs. The agent sees a short index of the skills it has and loads
one when the task calls for it; the answer then shows a "Used skill" line. Skills never grant
anything by themselves: tools, internet access and approvals work exactly as without them.

## Where skills come from

Open **Skills** in the top bar (`/me/skills`). It has four tabs:

- **Catalog**: the site's Skill Registry. Search, sort, and read each skill's details, evals and
  license. Team admins press **Install skill** (**Install in this team**) to add one to the team;
  a team setting can let contributors install too.
- **Team**: the team's skills. A team admin sets each one's access: **Required (always loaded)**,
  **On by default (members may turn it off)**, **Available (members turn it on)** or **Hidden (only
  agents that name it)**, and whether it tracks the latest version.
- **Mine**: your personal skills.
- **Workbench**: your drafts, and drafts teammates shared with you.

In a conversation, **+** → **Skills** shows the skills available to you there. An agent can also
name the skills it loads (see [Agents](agents.md)).

## Write a skill in the Workbench

1. On the **Workbench** tab, create a **New draft**: give a **Skill name** and **Start from**
   **Blank** or a template, or **Upload a zip or SKILL.md**. You can also **Import a skill** from a
   Git repository or a zip URL (https).
2. The draft opens with three tabs:
   - **Define**: the file tree and the editor for `SKILL.md` and its files.
   - **Test**: a chat that runs with the draft loaded, to see it in use.
   - **Eval**: run the draft's eval cases and read the scorecard (pass rate with and without the
     skill, cost, duration).
3. **Save version** stores an immutable version, as a **Team skill** (contributors and team
   admins) or **My personal skill**, with a version number and a one-line **Changelog**.

**Share with team builders** lets contributors and team admins open your draft.

From a conversation, **Make a skill from this** (or `/skill`) opens a new skill-writing
conversation with the current one attached read-only. When the agent has written the skill under
`skills/<name>/` in My files, **Save skill to Workbench** (or `/saveskill <name>`) brings it into
the Workbench as a private draft.

## kobe.skill.yaml

`kobe.skill.yaml` sits next to `SKILL.md` and describes the skill for the registry: its name and
version (which must match `SKILL.md` and the saved version), a summary of up to 280 characters,
up to ten topic tags, a license, the internet hosts and pip or npm packages it needs, and a
changelog. It is needed to promote a skill to the Site Registry, not to use one in your team.

You do not have to write it by hand. When a draft or version has none, **Create kobe.skill.yaml**
asks a model your team enables (**Model for the manifest**) to fill in the summary, tags and
capabilities from your files, with the license you choose (Proprietary, Apache-2.0, MIT or
BSD-3-Clause). Review the file, then save a new version: the evals run again before promotion.
Listing hosts or packages in the file does not allow them; your team's internet settings still
decide.

## Promote to the Site

**Promote to Site** on a saved team version shows what would leave the team and sends the request
to your team admins ("they confirm before it leaves the team"). After they confirm, it is submitted
to the Site Registry, where site admins review it. Once approved it appears in every team's
Catalog.

## Related

- [Agents](agents.md)
- [Internet access](../internet-and-approvals/internet-access.md)

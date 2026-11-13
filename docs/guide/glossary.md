---
title: Glossary
summary: Short definitions of the words Kobe uses, from agent and approval to workspace and scratchspace.
section: Reference
order: 3
audience: member
---

The words Kobe uses, in alphabetical order, each with a link to the page that explains it.

## Terms

**Access mapping.** A site admin's rule that gives people with an identity provider's app role or
group a team role in one team. See [Single sign-on](admin/single-sign-on.md#access-mappings).

**Agent.** A configured assistant: system prompt, model, skills, connectors, tool rules and
approval mode. Personal, team or site-wide. See [Agents](agents/agents.md).

**App.** An interactive card a connector tool returns, shown in an answer, the artifact column or
the rail. See [Connectors and apps](connectors-and-apps.md).

**Approval.** Your yes or no before a tool call runs. A **remembered approval** lets the same tool
run without asking for a while. See [Approvals](internet-and-approvals/approvals.md).

**Approval mode.** How readily an agent asks: Ask on write, Ask for every tool, Auto, or (admins
only) Dangerous.

**Artifact.** Something the agent made for you to keep (a document, a chart, code), shown in a tab
of the artifact column. **Edit as file** copies a text artifact into My files.

**Artifact column.** The right-hand column with tabs for files, artifacts and apps.

**Branch.** One line of a conversation after an edit or regenerate. See
[Sharing, forks and the conversation tree](chat/sharing-and-branches.md).

**Checkout.** Your writable copy of a project, from **Check out to edit** until you commit or
discard.

**Commit.** A saved version of a project's files, with a message and an author.

**Connector.** A link to another system through MCP that gives the agent tools. The built-in
**Kobe** connector is Kobe's own: the guide for every agent, and admin tools where admins turn
them on. See [Admin from a conversation](admin/admin-from-a-conversation.md).

**Contributor.** A team role between member and team admin: builds agents, publishes skills,
creates projects.

**Egress.** The agent's internet access, through Kobe's egress proxy. The **egress ceiling** is the
site's list of allowed sites. See [Internet access](internet-and-approvals/internet-access.md).

**Fork.** A new thread copied from another up to a point.

**Identity provider.** Your organization's sign-in service (for example Microsoft Entra ID) that
Kobe trusts for single sign-on.

**Kernel.** The live Python process in your sandbox that runs notebooks and `.py` files. See
[Notebooks and Python](files/notebooks.md).

**Linked sign-in.** An identity provider account joined to a Kobe account, so either signs you
in. Linking needs your Kobe password or passkey, or an administrator's **expected link**. See
[Signing in with your organization](getting-started/single-sign-on.md).

**Managed member.** A team membership an access mapping made; it shows "Managed by _provider_"
and changes only at the provider until a team admin uses **Take over**.

**Memory.** What the agent knows between conversations, on the **My memory** page: **Memories**
(short statements you keep, **Only in this workspace** or in **All my workspaces**) and **Notes** (files the
agent writes, yours and a project's). See [Memory](memory.md).

**Memory steward.** A grant on top of any role, not a role: a **workspace** memory steward
(given by a team admin on **Members and roles**) curates the workspace's shared memories with the
team admins; a **Site** memory steward (given by a site admin in **Site roles**) curates Site
memory and accepts or dismisses the proposals team admins send to the Site. Only team admins send
memories to the Site, and only site admins set Policy. See
[Team admin overview](admin/team-admin.md#team).

**Model.** The AI model that writes the answers. See [Models and thinking levels](models.md).

**My files.** Your private files in the workspace, mounted at `/workspace` in your sandbox; the
concept is called your **scratchspace**.

**Project.** A shared, versioned set of files, instructions, memory and conversations, with owners,
editors and readers. See [Workspaces, My files and projects](files/workspaces-and-projects.md).

**Proposal.** A change the agent suggests to a file; nothing is written until you commit it. See
[Editing files](files/file-editor.md).

**Rail.** The left-hand column with the workspace switcher, New conversation, the Threads panel
and your files.

**Roster.** The list of agents a team or the whole site can run.

**Run.** One turn of the agent's work, from your message to the end of its answer.

**Sandbox.** The isolated, private machine where your agent works. One per person per workspace;
it sleeps when idle.

**Schedule.** A prompt sent to an agent at set times.

**SCIM.** The standard an identity provider uses to create, update and deactivate Kobe accounts
on its own. A **SCIM token** (created in the Site console, shown once) lets one provider do this.

**Single sign-on (SSO).** Signing in to Kobe with your organization's account instead of a Kobe
password. See [Signing in with your organization](getting-started/single-sign-on.md).

**Site.** The whole Kobe installation of your organization, run by site admins.

**Skill.** Packaged know-how an agent can load: `SKILL.md` plus files. See [Skills](agents/skills.md).

**Team.** The people of a workspace and their roles. Workspace and team are the same thing seen
from two sides.

**Thinking level.** How much the model reasons before answering: off, low, medium or high.

**Thread.** A conversation, with all its branches.

**Workspace.** Where a team works: its people, conversations, projects, agents and settings. You
can belong to several and switch between them.

## For agents

An AI agent working inside Kobe should read [Concepts for agents](for-agents/concepts.md), which
maps these words to tools and paths.

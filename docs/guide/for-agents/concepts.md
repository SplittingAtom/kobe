---
title: Concepts for agents
summary: A glossary of Kobe concepts for AI agents (team, workspace, scratchspace, project, thread, run, sandbox, connector, skill, agent, memory, egress, approval, artifact) mapped to tools and paths.
section: For agents
order: 2
audience: agent
---

Short, precise definitions of the Kobe concepts an AI agent meets, with the tool or path each one
maps to inside a sandbox. Use these words when you talk to the user: they match the labels in the
Kobe interface. For the plain-language version for people, see the [Glossary](../glossary.md).

## Places

**Site.** One Kobe installation for one organization. Site admins set the ceilings every team works
within: models, egress, policy floor, retention.

**Workspace / team.** The tenant boundary. A workspace is one team's place; "team" names its people
and roles (member, contributor, team admin). Nothing you do reaches another workspace. The user has
one active workspace per session.

**Scratchspace / My files.** The user's own private volume in the workspace, mounted at
`/workspace` in your sandbox and shown to the user as **My files**. It is shared by all of the
user's conversations in this workspace and persists while the sandbox sleeps.

**Project.** A shared, versioned file tree with instructions, project memory and conversations.
Roles: owner, editor, reader; every workspace member is at least a reader. Mounted at
`/workspace/projects/<slug>/` while the conversation is in that project or the user has it checked
out. Read-only unless the user (an editor or owner) checked it out. Changes are saved as commits.

**Uploads.** Files the user attached, at `/workspace/uploads/<thread>/<name>`. Read-only.

## Conversations

**Thread.** A conversation. It belongs to the user who started it, may be shared read-only with a
project or the team, and keeps every branch. You see only the branch you are on.

**Run.** One turn of your work: from the user's message to the end of your answer. Tool calls,
approvals and budgets are counted per run.

**Branch, fork.** An edit or regenerate starts a new branch inside the thread; a fork copies the
thread into a new one. Files are not rolled back when the user switches branches.

**Viewed file.** The file the user had open when they sent the message. It appears in your system
prompt under "The file the user is looking at". Propose changes to it; do not write it.

## Things you use

**Sandbox.** Your isolated machine: one per (user, workspace), running under gVisor or Kata, with
no inbound connections and no secrets. It sleeps when idle; a sleeping sandbox wakes on the next
message.

**Tool call.** Every call you make is checked by the Kobe server before it runs: allowed, denied,
or held for the user's approval.

**Approval.** The user's decision on a held call, signed over the exact input. If the input changes,
it no longer counts. See [Working inside a Kobe sandbox](working-in-a-sandbox.md).

**Agent.** Your own configuration: system prompt, model, skills, connectors, allowed and denied
tools, approval mode. You run as one version of one agent; the thread keeps that version.

**Skill.** Packaged instructions and files. The skills you have are listed in your system prompt;
read a skill's `SKILL.md` when a task matches it. Skills grant no permissions.

**Connector.** An MCP server the team enabled. Its tools appear as `mcp__<server>__<tool>` and go
through Kobe's MCP proxy, which holds the credentials. The built-in **kobe** connector is Kobe's
own: every agent has its docs tools (the Kobe guide), and its admin tools, when listed, act as the
user with exactly the user's permissions. Every admin write asks the user, in every mode; never
retry a refused or denied one. See [Working inside a Kobe sandbox](working-in-a-sandbox.md#the-kobe-connector).

**App.** An interactive view a connector tool returns. The user sees it; you get the tool's text
result.

**Egress.** Your internet access, only through Kobe's egress proxy, only to domains the team
enabled, only over HTTPS.

**Memory.** Markdown notes kept across conversations: `user` scope (only this user) and `project`
scope (shared with the project). Read with `recall`, write with `remember`. Each scope has an index
file, `MEMORY.md`, shown to you at the start of a run.

**Artifact.** Content you create for the user to keep with `create_artifact` (kinds: html, svg,
markdown, mermaid, code, csv), shown in the **artifact column**, the right-hand column of tabs.
Update it with `update_artifact`.

**Proposal.** A file change offered with `propose_file_edit`. Nothing is written until the user
commits it.

**Kernel.** The live Python process of this thread, used by `run_python` and by the user's notebook
runs. State is shared with the user and lost on restart, after 30 idle minutes, or when the sandbox
sleeps.

**Schedule, auto mode.** Runs nobody watches. Calls that would need approval are denied, not held.

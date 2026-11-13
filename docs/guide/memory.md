---
title: Memory
summary: How Kobe remembers things between conversations, where personal and project memory live, how to read, edit or undo them, which site and workspace switches control notes and memories, and how the learning model is chosen.
section: Memory
order: 1
audience: member
---

Memory lets the agent keep notes that last beyond one conversation: your preferences, facts about
your work, decisions a project made. Memory is a set of plain Markdown files that you can read and
edit at any time. This page explains how it works and how to control it.

## Two kinds of memory

- **My memory** is about you. Only you and your own agents read it. The agent saves to it straight
  away; the conversation shows a **Memory updated** chip with **Undo**.
- **Project memory** belongs to a project. Everyone who can read the project can read it. Because
  it is shared, an agent's write to it waits for approval by a project member before it is stored.
  The agent writes project memory only in a conversation of an editor or owner of that project.

Each kind is a small set of `.md` files with one index file, `MEMORY.md`, and topic files such as
`topics/clients.md`.

## How the agent uses memory

At the start of each run the agent gets the index of your memory (and of the conversation's
project, if any). It has two tools:

- **remember** saves or appends a note to a memory file;
- **recall** reads a memory file or searches memory by text. It never needs approval.

Ask in plain words: "Remember that I report in euros", "What do you remember about the Q3 plan?",
"Forget what you saved about my old manager" (or delete it yourself, below). The agent is told
never to store secrets or passwords in memory; do not ask it to.

## See and edit your memory

Open **My memory** in the top bar (`/me/memory`). The page lists your memory files with their size
and when they were updated. Open a file to read it, **Edit** and **Save** it, **Delete** it, or open
its **Version history** to restore an earlier version. Everything is shown as plain text.

To see a project's memory, pick the project at the top of the same page, or use **Project memory**
on the project's page. Readers can read it; what you can change follows your project role.

## Switches that control memory

Memory has switches at two levels, the site (site admins, in the site console's **Settings ›
Memory**) and each workspace (team admins, in **Workspace settings › Memory**). A switch works only
while it is on at both levels that have it. Every switch is on unless an admin turned it off.

- **Allow memory** (site and workspace) is the master switch. Off means no notes (the remember and
  recall tools and the memory index) **and** no memories in that workspace or on the site.
- **Allow project notes** (site and workspace): project memory, as above. Needs memory.
- **Allow memories** (site and workspace): short statements Kobe knows about you, your workspace
  and the site, given to the agent at the start of each run. Needs memory. (Memories arrive with
  Kobe v1.3; the switches are in place so admins can decide beforehand.)
- **Workspace memories** (workspace): memories everyone in the workspace shares, curated by team
  admins and memory stewards.
- **Site memories reach this workspace's runs** (workspace): knowledge the site keeps for every
  workspace. **Site Policy** reaches the workspace's runs even when this is off.
- **Portable preferences** (site): your preferences (how you like answers, units, tone) follow you
  into every workspace you belong to. Facts about work never leave their workspace.
- **Learn from this chat** (site and workspace): you can ask Kobe to suggest memories from a
  conversation and review every suggestion before anything is saved.
- **Members may propose to the Site** (site and workspace): workspace memories can be proposed to
  the site; a team admin confirms before anything leaves the workspace.

Turning a switch off stops its use from the next run on; nothing stored is deleted, and turning
it back on brings everything back.

### The learning model

Learn from this chat uses a **learning model** an admin chose: the workspace's own learning model
when a team admin set one (Workspace settings › Memory, from the models enabled in the workspace),
otherwise the site's learning model, which the workspace must have enabled. If the chosen model is
not enabled in the workspace, or none is set, Learn is unavailable and says why: it never switches
to another model, and never uses the conversation's model. The Memory page of Workspace settings
shows which model Learn uses now.

### Site memory settings

Site admins also set, under **Settings › Memory**: the context budget (how much room memories may
take at the start of a run, 4 to 16 KiB, 8 by default), the most memories each place may hold, how
many versions of a memory are kept (50), when an unconfirmed memory counts as stale (90 days), the
retention window for archived memories (365 days), learning rate limits, and an embedding model
that is not used yet. Search always uses English word matching; there is no language setting.

## What memory is not

Recall finds text in your memory files; it does not search by meaning. A semantic memory, which
would let the agent find related notes by meaning across conversations, is planned but not
available yet.

## Related

- [Workspaces, My files and projects](files/workspaces-and-projects.md)
- [Approvals](internet-and-approvals/approvals.md)

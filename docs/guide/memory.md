---
title: Memory
summary: How Kobe remembers things between conversations, where personal and project memory live, how to read, edit or undo them, and which switches control memory.
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

Memory can be turned off at two levels, and both must be on for it to work:

- In the team console's **Memory** page, team admins switch **memory** (agents can remember notes
  about a person and recall them in later chats) and **project memory** (needs memory to be on).
- Site admins have the same two switches for the whole site, in the site console's **Settings**.

Turning memory off removes the remember and recall tools and the memory index from the next runs;
stored files are kept.

## Memory in your notifications

Shared memory needs people to review it, so the **Notifications** bell in the top bar tells you
when it is your turn. Each notification has a button that opens the place where you act:

- **A proposal or suggestion arrived** (to the people who review it): a Workspace memory proposal
  (opens the team console's **Memory** page), a reader's suggestion for a project's notes (opens
  the project) or a Site memory proposal (opens Site memory).
- **Your proposal or suggestion was accepted, dismissed or sent back for changes**, naming who
  decided, or **expired** undecided. A Site proposal also tells the Site's curators when its Team
  admin **confirmed** it.
- **Memories to review**: Kobe found things to remember in a conversation while you were
  elsewhere ("3 memories to review"); the button opens that conversation's To review section.
- **A memory is 80% full**: Workspace or Site memory is close to its limit (to its curators).
- **A reminder**: something you review has waited a week. Each waiting item reminds you once.
- **A digest**: more than five notifications of one kind within an hour are rolled into one item
  ("4 more Workspace memory proposals in the last hour"); the first five arrive one by one. The
  digest becomes unread again when it grows.

Notifications name people and items, never the text of a memory. These notifications come with
the semantic memory features that are being rolled out; until then the bell shows none of them.

## What memory is not

Recall finds text in your memory files; it does not search by meaning. A semantic memory, which
would let the agent find related notes by meaning across conversations, is planned but not
available yet.

## Related

- [Workspaces, My files and projects](files/workspaces-and-projects.md)
- [Approvals](internet-and-approvals/approvals.md)

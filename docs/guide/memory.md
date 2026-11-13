---
title: Memory
summary: How Kobe remembers things between conversations, the Memories and Notes tabs of My memory, how to add, edit, pin, archive or undo memories and notes, which site and workspace switches control notes and memories, and how the learning model is chosen.
section: Memory
order: 1
audience: member
---

Memory lets the agent keep what it should know beyond one conversation: your preferences, facts
about your work, decisions a project made. It comes in two forms, side by side on one page, **My
memory** in the top bar (`/me/memory`):

- **Memories** (the first tab): short statements, one per line, such as "Prefers answers in
  euros". You add and edit them yourself, and the agent is given them at the start of each run.
  See [Your memories](#your-memories).
- **Notes** (the second tab): plain Markdown files the agent writes with its **remember** tool and
  reads with **recall**. The rest of this section is about notes.

This page explains how both work and how to control them.

## Two kinds of notes

- **My notes** are about you. Only you and your own agents read them. The agent saves to them
  straight away; the conversation shows a **Note saved** chip with **Undo**.
- **Project memory** (a project's notes) belongs to a project. Everyone who can read the project can read it. Because
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

## Your memories

The **Memories** tab of **My memory** is where you keep your own memories. It has two groups:

- **Only in this workspace**: memories only you and your agents in this workspace read. Facts,
  conventions, definitions and decisions about your work always stay here. (Memories everyone in
  the workspace shares are **Workspace memories**, kept by team admins and memory stewards.)
- **All my workspaces**: preferences that follow you into every workspace you belong to (how you
  like answers, units, tone).

**Add a memory** with its text (at most 500 characters), its kind (preference, fact, convention,
definition or decision) and up to five tags, separated by commas. For a preference you can tick
**Use in all my workspaces**; Kobe then asks **Use in all my workspaces?** and shows the text, so
nothing about your work leaves the workspace by accident. Other kinds can't be moved there.

Each memory has **Edit**, **Pin** and **Archive**. Pinned memories (up to 10 in each group) are
listed first and always given to your agents; **Show more** lists older ones. Archiving never
deletes: **Show archived** lists archived memories with **Restore**. After every change the page says what happened (**Memory saved**, **Archived**,
...) with **Undo**; an undone edit brings back the version before it.

Every save runs the [checks](#what-kobe-checks-before-a-memory-is-saved) first. Their warnings
appear under the memory you were saving, a similar memory as a link to it, with **Save anyway**;
a secret is never saved. If the memory changed in another tab since you opened it, Kobe says so;
**Reload** shows the saved text above your draft, which is kept, and **Save** replaces it. An
**Undo** that comes too late (the memory changed since) is withdrawn. Each group says when it is
80% full, and when it is full (by default 300 memories only in this workspace and 50 in all your
workspaces; a site admin can change this): archive some before adding more.

## See and edit your notes

Open the **Notes** tab of **My memory** (`/me/memory?tab=notes`). It lists your memory files with
their size and when they were updated. Open a file to read it, **Edit** and **Save** it, **Delete** it, or open
its **Version history** to restore an earlier version. Everything is shown as plain text.

To see a project's memory, pick the project at the top of the Notes tab, or use **Project memory**
on the project's page (it opens on the Notes tab). Readers can read it; what you can change follows your project role.

## Switches that control memory

Memory has switches at two levels, the site (site admins, in the site console's **Settings ›
Memory**) and each workspace (team admins, in **Workspace settings › Memory**). A switch works only
while it is on at both levels that have it. Every switch is on unless an admin turned it off.

- **Allow memory** (site and workspace) is the master switch. Off means no notes (the remember and
  recall tools and the memory index) **and** no memories in that workspace or on the site; Site
  Policy still applies unless the site's switch is off (below).
- **Allow project notes** (site and workspace): project memory, as above. Needs memory.
- **Allow memories** (site and workspace): short statements Kobe knows about you, your workspace
  and the site, given to the agent at the start of each run. Needs memory. (Memories arrive with
  Kobe v1.3; the switches are in place so admins can decide beforehand.)
- **Workspace memories** (workspace): memories everyone in the workspace shares, curated by team
  admins and memory stewards.
- **Site memories reach this workspace's runs** (workspace): knowledge the site keeps for every
  workspace. **Site Policy** reaches the workspace's runs even when this is off.

**Site Policy** is governance: the site's rules reach every workspace's runs even when a
workspace turns memory, memories or Site memories off. Only the site's own **Allow memory** switch
turns Policy off.

- **Portable preferences** (site): your preferences (how you like answers, units, tone) follow you
  into every workspace you belong to. Facts about work never leave their workspace.
- **Learn from this chat** (site and workspace): you can ask Kobe to suggest memories from a
  conversation and review every suggestion before anything is saved.
- **Members may propose to the Site** (site and workspace): workspace memories can be proposed to
  the site; a team admin confirms before anything leaves the workspace. Needs **Workspace
  memories** on.

Turning a switch off stops its use from the next run on; nothing stored is deleted, and turning
it back on brings everything back.

### The learning model

Learn from this chat uses a **learning model** an admin chose: the workspace's own learning model
when a team admin set one (Workspace settings › Memory, from the models enabled in the workspace),
otherwise the site's learning model, which the workspace must have enabled. If the chosen model is
not enabled in the workspace, or none is set, Learn is unavailable and says why: it never switches
to another model, and never uses the conversation's model. The Memory page of Workspace settings
shows which model Learn uses now, or the reason it can't run (which switch, at which level, or
which model is missing). A chosen model that was disabled or removed stays shown as such until
an admin picks another.

### Site memory settings

Site admins also set, under **Settings › Memory**: the context budget (how much room memories may
take at the start of a run, 4 to 16 KiB, 8 by default), the most memories each place may hold (by
default 300 per person only in a workspace, 50 per person in all their workspaces, 1,000 per
workspace and 1,000 on the site), how
many versions of a memory are kept (50), when an unconfirmed memory counts as stale (90 days), the
retention window for archived memories (365 days), learning rate limits, and an embedding model
that is not used yet. Search always uses English word matching; there is no language setting.

## What Kobe checks before a memory is saved

Memories are short statements: facts, preferences, conventions, definitions and decisions. Every
way of saving one (the editor, an edit or **Undo**, restoring from the archive, turning Site Policy
on or off, an import, accepting a suggestion from **Learn from this chat**, approving a proposal)
runs the same checks first. Restoring an archived memory is checked like a new save, so Policy
added or rules changed while it was archived apply to it. The checks read the text the way a
person would: look-alike letters from other alphabets, invisible characters and accents, blank
filler characters (read as spaces), full-width letters, letters spaced out ("i g n o r e") and
links written as `hxxp://example[.]com` are read as the plain words they stand for.

- **Secrets are never saved.** A password, API key, access token or private key stops the save,
  at every level, Site Policy included, and nobody can save it anyway. That includes a password in
  a connection string (`postgres://user:password@host`), "the password is …" written in a
  sentence, Stripe and GitLab keys, sign-in tokens (JWTs), a token typed in groups or split with
  hyphens, and a token hidden in base64 or hex. Tags are checked too. Remove it and save again;
  keep credentials in a connector or your password manager.
- **Instructions to the agent get a warning.** A memory states something; it never gives the agent
  orders. You are warned when a memory reads like an order to the agent ("you must…", "from now
  on…", "ignore previous instructions"), mentions tools, approvals or the system prompt ("skip
  approval", "call the shell tool"), asks the agent to fetch or open a web address, or asks to
  widen internet access or use a connector ("add example.com to the allowlist", "use the CRM
  connector"). A memory can't change any of these: internet access is asked for with **Request
  access**, connectors are set up by admins, and approvals follow the site's rules. Site **Policy**
  is exempt from this check, because Policy is the site's own rules.
- **Personal data in shared memories gets a warning.** In Workspace and Site memories, which many
  people read, you are warned about email addresses, phone numbers, and a person's name near
  sensitive information (health, pay, discipline, family or identity documents). Your own memories
  are not checked for this.
- **Links are shown with their host.** A link is a web address in any spelling (with
  `https:`, `www.` or a path). You are warned when a link points to a host this workspace's sandboxes can't reach (it isn't on the workspace's internet
  allowlist, or the site's allowlist no longer holds it). Site memories and memories in all your
  workspaces are judged by the site's allowlist, since they reach every workspace (each workspace
  may still allow less). A host written
  with look-alike letters (`gіthub.com` with a Cyrillic "і") is shown in its encoded form
  (`xn--…`) with its own warning, so it can't pass for the real site.
- **Similar memories get a warning.** When the same place already holds a very similar memory,
  you are shown it first.
- **Contradicting Site Policy stops the save.** When a memory may contradict a Policy item (it is
  about the same thing but says otherwise, or adds to it), the save stops and names the Policy
  item. Restating Policy is fine.
- **Length limits.** A memory holds at most 500 characters; the reason given with a suggestion or
  proposal at most 1,000, and a reviewer's note at most 500.

For each warning you can **Save anyway**. On your own memories that is your call. On Workspace and
Site memories it is a deliberate tick. Either way the memory's version records that it was saved
over a warning (for a restore or a Policy change, which add no version, the audit log alone
records it), and the audit log records who did it, on which memory and version, and which warnings
it overrode (never the text). Saving over a Policy conflict is a separate choice, made by the
memory's owner for your own memories and by curators (team admins and memory stewards, or the
site's memory curators) for shared ones; it is recorded and audited the same way, naming the
Policy items saved over.

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

Recall finds text in your memory files; it does not search by meaning. Memories are matched to a
conversation by their words, not by meaning.

## Related

- [Workspaces, My files and projects](files/workspaces-and-projects.md)
- [Approvals](internet-and-approvals/approvals.md)

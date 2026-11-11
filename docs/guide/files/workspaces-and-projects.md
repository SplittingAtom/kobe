---
title: Workspaces, My files and projects
summary: What a workspace, My files (your scratchspace) and a project are, who can do what in a project, and how to work on a project in a conversation.
section: Files and editing
order: 1
audience: member
---

Kobe organises files in three layers. The **workspace** is your team's place. **My files** is your
own private space inside it. **Projects** are shared, versioned folders the workspace works on
together. The Files tab of the rail shows all three as one tree.

## The workspace

A workspace is one team: its members, conversations, projects, agents, connectors and settings.
Nothing crosses from one workspace to another. If you belong to several, switch with the
**Workspace** switcher at the top of the rail; only one is active at a time. The team console calls
its people side **Team** and the settings side **Workspace settings**; it is the same thing.

## My files

**My files** (Kobe calls the idea your _scratchspace_) is your own volume in the workspace. Only you
and your agent see it. Every conversation you have runs in your own sandbox with My files mounted at
`/workspace`, so the agent in one conversation can pick up a file the agent in another wrote.

- **Upload file** in the Files panel adds a file; a file's **⋯** menu has **Open**, **Mention in
  message**, **Download**, **Rename**, **Move to…** and **Delete**.
- Files you attach to a message land in `uploads/<thread>/` and are read-only to the agent.
- **Add to project** on a file (or on an artifact) copies it into a project you can edit.
- **Promote to project…** on a My files folder's **⋯** menu (team admins and contributors) turns the
  folder into a new project you own, as its first commit.

Your files are kept while your sandbox sleeps and come back when it wakes.

## Projects

A project gathers instructions, a versioned file tree, project memory and shared conversations for
people working on something together. Find them under **Profile → Projects** (`/me/projects`) or
**Manage projects →** in the Files panel. **New project** creates one; team admins and contributors
can create projects, and the creator becomes the owner.

Every member of the workspace can read every project. Keep confidential work in My files or in a
separate workspace.

| Role       | Can                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reader** | Browse the files and history, read shared conversations and project memory, and start conversations on the project. The agent cannot change the project's files. |
| **Editor** | Everything a reader can, plus check out, edit and commit files, and accept the agent's proposed edits.                                                           |
| **Owner**  | Everything an editor can, plus change the project's settings (instructions, default agent), add and remove people, hand over ownership, archive or delete it.    |

Team admins can do everything in every project of their workspace. Everyone not named as an owner
or editor is a reader.

## Work on a project in a conversation

Start a conversation in a project with **New conversation in this project** or **Open in a
conversation** on the project page, or pick the project with the control next to the composer
("Add to a project") before you send the first message. The title then reads **Project / name**;
its project part has **Open project**, **Move to project…** and **Move out of the project**.

While you have a conversation in a project (or a checkout of it), the project is mounted in your
sandbox at `/workspace/projects/<slug>/`. The Files panel lists every project: the conversation's
project is marked "Active in this conversation", the others "Not in this conversation" and open
read-only. A conversation has one project at a time.

## Change project files

The mounted folder is read-only until you check it out:

1. **Check out to edit** (on a project file or in the project's menu; editors and owners). The
   folder becomes writable for you only, and the bar counts your changes.
2. Edit files yourself in the editor, or let the agent edit them.
3. **Commit…** names the change (up to 500 characters) and saves it as a new commit. If someone
   committed in the meantime, press **Update** to bring their changes into your copy, then commit
   again. **Discard** ends the checkout and throws your changes away.

In a project conversation an editor's agent can also propose an edit to a project file; **Accept**
commits it at once, with no checkout. The agent can commit a checkout itself with its
`commit_project` tool, after your approval or a team rule allows it. See
[Editing files](file-editor.md).

**History** on the project page lists every commit, newest first. Open a commit to see its changes,
download a file as of that commit or the whole project with **Download as zip**, and **Revert** to
add a new commit equal to an earlier one. History is never rewritten; a workspace setting may prune
old commits.

## Related

- [Editing files](file-editor.md)
- [Memory](../memory.md): personal and project memory
- [Glossary](../glossary.md)

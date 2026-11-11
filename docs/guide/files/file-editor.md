---
title: Editing files
summary: How to open, edit and save files in the editor, use Save As and the Rendered/Raw switch, and review the agent's proposed edits.
section: Files and editing
order: 2
audience: member
---

Files open in the editor in the artifact column. You and the agent can both work on the same
file: you edit and save it yourself, and the agent either writes it directly or proposes a change
for you to review. This page covers the editor, saving, and reviewing proposals.

## Open a file

- Click a file in the Files panel, or use **Open** in its **⋯** menu.
- Ask the agent to open it: it shows the file in a tab for you ("Opened _file_", with **Open
  again** on the card later).
- **Edit as file** on a text artifact (Markdown, code, CSV) copies it into My files as
  `artifacts/<name>`, where you can edit it like any file.

Text files up to 1 MB open in the editor; larger ones open read-only. Other types open in their
viewers.

## The editor toolbar

The editor fills the artifact column, and one toolbar at the top holds its controls:

- **Save** saves your changes. Each save names the version it started from, so it never overwrites
  someone else's change by accident.
- **Save As** saves the editor's text, unsaved changes included, to a new path you type (by default
  `<name>-copy` beside the file). If a file is already there, Kobe asks "already exists. Replace
  it?" first. The tab then moves to the copy. Read-only files (a project file you cannot commit, a
  thread upload) offer Save As but not Save; the copy goes into My files.
- The **Rendered/Raw** switch shows Markdown and similar files rendered, or as raw text to edit.
- For a `.py` file: **Run**, **Interrupt**, **Start** or **Restart** and the kernel's state. See
  [Notebooks and Python](notebooks.md).

On a narrow column Save As moves into the **More file actions** menu. A disabled button says why
in its tooltip.

## Review the agent's proposed edit

When you have a file open, the composer shows "Viewing _file_" and the agent is told to propose
changes to it instead of writing it. A proposal writes nothing until you commit it.

1. The conversation shows a "Proposed edit to _file_" card with **Review**. Turn on **Open edits
   automatically** on the card to open every new proposal for review as it arrives.
2. The editor shows a gold **Proposed edit** bubble with the agent's summary. The row under it
   steps through the changes (Previous, Next, "Change N of M") with **Accept** and **Reject** for
   the current change, then **Commit all** and **Discard all**.
3. In the text each change also has its own buttons: a green check (Accept change) and a red cross
   (Reject change).
4. You can keep typing while you review. **Commit all** saves exactly what you see.

In a project conversation an editor's agent can propose edits to the project's files; there
**Accept** commits the change to the project, with the agent's summary as the commit message (you
can edit it first). A reader's agent cannot propose project edits.

If the file changed after the proposal, the review offers only **Discard**; ask the agent to
propose again. Proposals stay available for 7 days after their run.

## When the file changes under you

- If the agent of this conversation writes the open file and you have no unsaved changes, the tab
  updates by itself.
- Any other change (another tab, another device, another conversation) shows a note at the top:
  "_who_ changed this file _when_" with **Reload**.
- If you have unsaved changes and save over a newer version, nothing is saved and the editor offers
  **Compare** (review the difference change by change), **Keep mine** and **Take theirs**.
- If the agent wrote the file before your save reached it, your version wins and the agent's
  version is kept beside it as `<name>.conflict-<time>`. The agent is told.

## Good habits

- **Save before you ask for a change.** The agent sees only saved text, never your draft.
- **Keep the file open when you want to review every change.** The agent then proposes instead of
  writing; it is not allowed to write the viewed file directly with its file tools. This guard does
  not cover shell commands or Python.
- **Let the agent write directly** for new files, generated output and bulk changes.
- Unsaved drafts live in this browser tab: a full page reload loses them (Kobe warns first).

## Read-only places

`projects/` (unless you have the project checked out) and `uploads/` are read-only: Save is
refused and the editor says so. See [Workspaces, My files and projects](workspaces-and-projects.md).

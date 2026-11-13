---
title: The Threads panel
summary: How to find, file, archive, delete, restore and export conversations (with your notes and memories), and see which files each thread used.
section: Chat and threads
order: 2
audience: member
---

Every conversation is a thread. The Threads panel is where you find, organise and clean up
threads. Open it with **Threads panel** on the rail's top line (on a phone, from the workspace
drawer). Clicking a thread's title opens it and closes the panel.

## Search and export

Search sits at the top of the panel: **Search threads** looks through thread titles and content,
and a hit opens on the branch where it was found. The bar's thread search does the same from
anywhere.

**Export my conversations** downloads all your threads in this workspace as a zip, as Pi sessions
and Markdown, including every branch and each thread's folder. The zip also holds your personal
notes and, in `memory-items.json`, your own memories: the ones you keep in this workspace and your
portable preferences, each with its kind, tags, status, dates and every kept version you wrote (with
the conversation of yours it came from and quotes of your own messages). Workspace and Site
memories, and anything other people wrote (including messages copied into a fork), are not
included; an item's `notes` says when something was left out. A legal hold does not change what
you get. Memories you kept in a workspace you have left are not in any export. To download one
conversation as Markdown, use `/export` in it.

## Folders

On windows 820 pixels and wider the folder tree is on the left and the chosen folder's threads
beside it; on narrower windows a folder dropdown sits above the list. The tree holds:

- **Current**: your threads that are not filed, with **Archived** folded under it;
- the workspace's folders, which every member sees (each member sees only the threads in them they
  may read);
- **Deleted**: threads in Trash.

**+ New folder** adds a folder. A folder's **⋯** menu has **Rename**, **New folder inside**
(folders nest up to three levels), **Move to…** and **Delete**. To file a thread, use **Save to
folder…** in its **⋯** menu, drag it onto a folder, or type `/folder <name>` in it. A thread lives
in one folder at most. A fork of a filed thread starts in the same folder.

## A thread's row

A thread's pin, trash can and **⋯** menu sit right after its title. Pointing at a row (or reaching
it with the keyboard) shows a pill behind it. The **⋯** menu (**Thread actions**) holds **Pin**,
**Move to project**, **Save to folder**, **Archive**, **Share**, **Make a skill from this**,
**Files (N)…** (when the thread used files) and **Delete**.

## Archive, delete and restore

- **Archive** moves a thread out of Current into Archived; **Unarchive** brings it back.
- **Delete** moves a thread to Trash (the **Deleted** folder) at once, without asking. In Trash,
  **Restore** puts it back where it was, folder included, and **Delete forever** asks first, then
  removes it. Threads in Trash are deleted for good after 30 days.

Archiving or deleting a thread also ends the approvals you remembered for "this conversation".

## Which files a thread used

Kobe records a link whenever a thread's agent reads or writes a file in My files or in a project
with its file tools, and when a file is attached, uploaded or shared in that thread. Shell commands
are not looked at, so a file the agent only touched through `bash` has no link.

- **Three rails.** On windows 1,100 pixels and wider the panel shows folders, threads and a
  workspace rail with your file tree. The workspace rail is read-only here: open folders, and click
  a file to open it in the artifact column.
- **Resize.** Drag the line between the threads and the workspace rail, or focus it and use the
  arrow keys (Left widens the rail), Page Up/Down and Home/End; Enter or a double-click goes back
  to the default. Your width is remembered on every device you sign in on.
- **Lines.** Point at a thread (or focus it) and lines run to the files it used: a **solid** line
  for a file it wrote or changed, a **dashed** line for one it only read. A file inside a closed
  folder links to the folder, with a count; files scrolled out of view show as "N more
  above/below". Point at a file or folder to see the threads that used it; threads not in the list
  (for example archived ones) are named below the rail.
- **Pin the lines.** The pin button on a thread or file row ("Keep lines shown for …") keeps its
  lines on screen after the pointer leaves. It shows when you point at or focus the row (always on
  touch screens); press it again to let go.
- **Lists.** **Files (N)…** in a thread's **⋯** menu lists the thread's files under the row, as
  links (written or read; deleted files say "(deleted)"); Escape or **Hide files** closes the list.
  A file's **⋯** menu has **Used in (N threads)**. These lists work by keyboard and screen reader,
  and on narrow windows, where there are no lines.

In a thread a teammate shared with you, files in projects you can read are shown by name. Files in
the teammate's own My files are never named: they count towards Files (N)… and show as "N files
you can't see". The same holds the other way round for threads you share.

## Related

- [Sharing, forks and the conversation tree](sharing-and-branches.md)
- [Workspaces, My files and projects](../files/workspaces-and-projects.md)

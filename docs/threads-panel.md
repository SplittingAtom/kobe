# The Threads panel

A guide for members. The Threads panel opens from **Threads** on the rail's top line (on a phone,
from the workspace drawer). Specs: `docs/specs/thread-lineage-and-folders.md` (folders) and
`docs/specs/thread-file-map.md` (which files each thread used).

## Folders and threads

Search and **Export** sit on top. On windows 820 px and wider the folder tree (Current with
Archived under it, the team's folders, Deleted) is on the left and the chosen folder's threads
beside it; narrower, a folder dropdown sits above the list. **+ New folder** adds a folder; a
thread's ⋯ menu has **Save to folder…**. Clicking a thread's title opens it and closes the panel.

## Which files a thread used

Kobe records a link whenever a thread's agent reads or writes a file in your workspace or in a
project with its file tools (`read`, `write`, `edit` and the like), and when a file is attached,
uploaded or shared in that thread. Shell commands are not looked at, so a file the agent only
touched through `bash` has no link.

- **Three rails.** On windows 1,100 px and wider the panel shows folders | threads | workspace.
  The workspace rail is your file tree, read-only here: open folders, click a file to open it in
  the artifact column (no rename, delete or drag).
- **Lines.** Point at a thread (or move the keyboard focus to it) and lines run from it to the
  files it used: a **solid** line for a file it wrote or changed, a **dashed** line for one it
  only read. A file inside a closed folder links to the folder, with a count; files scrolled out
  of view show as "N more above/below". Point at a file or folder in the workspace rail to see the
  threads that used it; threads that are not in the list (for example in Archived) are named below
  the rail.
- **Pin.** The pin button on a row ("Keep lines shown for …") keeps its lines shown after the
  pointer leaves, which helps on touch screens or with many lines. Press it again to let go.
- **Lists.** Every thread with links shows **Files (N)** under its title: open it for the files as
  links (written or read; deleted files are named "(deleted)"). A file's ⋯ menu has
  **Used in (N threads)**. These lists are the way to the same links by keyboard and screen
  reader.
- **Narrow windows.** Below about 1,100 px there is no workspace rail and no lines; the lists
  (Files (N), Used in) still work.

## Shared threads

In a thread a teammate shared with you, files in projects you can read are shown by name. Files in
the teammate's own workspace are never named: they count towards Files (N) and show as "N files
you can't see". The same holds the other way round for threads you share.

# The Threads panel

A guide for members. The Threads panel opens from **Threads** on the rail's top line (on a phone,
from the workspace drawer). Specs: `docs/specs/thread-lineage-and-folders.md` (folders) and
`docs/specs/thread-file-map.md` (which files each thread used).

## Folders and threads

Search and **Export** sit on top. On windows 820 px and wider the folder tree (Current with
Archived under it, the team's folders, Deleted) is on the left and the chosen folder's threads
beside it; narrower, a folder dropdown sits above the list. **+ New folder** adds a folder; a
thread's ⋯ menu has **Save to folder…**. Clicking a thread's title opens it and closes the panel.
A thread's pin, trash can and ⋯ menu sit right after its title; pointing at a row (or reaching it
with the keyboard) shows a pill behind it.

## Which files a thread used

Kobe records a link whenever a thread's agent reads or writes a file in your workspace or in a
project with its file tools (`read`, `write`, `edit` and the like), and when a file is attached,
uploaded or shared in that thread. Shell commands are not looked at, so a file the agent only
touched through `bash` has no link.

- **Three rails.** On windows 1,100 px and wider the panel shows folders | threads | workspace.
  The thread column is as wide as its titles and the workspace rail takes the rest of the panel,
  scrolling on its own. The workspace rail is your file tree, read-only here: open folders, click
  a file to open it in the artifact column (no rename, delete or drag).
- **Resize.** Drag the line between the threads and the workspace rail, or focus it and use the
  arrow keys (Left widens the rail), Page Up/Down and Home/End; Enter or a double-click goes back
  to the default. Your width is remembered on every device you sign in on.
- **Lines.** Point at a thread (or move the keyboard focus to it) and lines run from it to the
  files it used: a **solid** line for a file it wrote or changed, a **dashed** line for one it
  only read. A file inside a closed folder links to the folder, with a count; files scrolled out
  of view show as "N more above/below". Point at a file or folder in the workspace rail to see the
  threads that used it; threads that are not in the list (for example in Archived) are named below
  the rail.
- **Pin.** The pin button on a thread or file row ("Keep lines shown for …"), shown when you point
  at the row or focus it (always on touch screens), keeps its lines shown after the pointer
  leaves. A pinned row's pin stays visible; press it again to let go.
- **Lists.** A thread with links has **Files (N)…** in its ⋯ menu: it opens the thread's files
  as links under the row (written or read; deleted files are named "(deleted)"); Escape or
  **Hide files** closes the list. A file's ⋯ menu has **Used in (N threads)**. These lists are
  the way to the same links by keyboard and screen reader.
- **Narrow windows.** Below about 1,100 px there is no workspace rail and no lines; the lists
  (Files (N)…, Used in) still work.

## Shared threads

In a thread a teammate shared with you, files in projects you can read are shown by name. Files in
the teammate's own workspace are never named: they count towards Files (N)… and show as "N files
you can't see". The same holds the other way round for threads you share.

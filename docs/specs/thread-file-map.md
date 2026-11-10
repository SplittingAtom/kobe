# Kobe — Threads panel: which files each thread used

Status: **draft; decisions TFM1–TFM4 by Chris 2026-11-10 (§8), Q4, Q6, Q7 open.** Requested by Chris, 2026-11-10. Written against
main `d58136f3`. Builds on the Threads panel (KOBE-453, CE5), thread folders (TF7, KOBE-536,
`docs/specs/thread-lineage-and-folders.md`) and Workspaces (`docs/specs/workspaces.md`).

Request (Chris, 2026-11-10): the Threads panel has two columns, the folder tree on the left and the
threads on the right. Show which files are associated with each thread: put the threads list in the
middle and add a third rail on the right with the workspace. Rolling over a thread draws lines from
it to the files that thread used; rolling over a file in the workspace rail draws lines to the
threads it is connected to.

## 1. Today

- **Panel.** `apps/web/components/shell/threads-panel.tsx`: search and Export on top; at the `wide`
  and `medium` shell bands (820 px and wider) a grid `220px | 1px | 1fr`: the folder tree
  (Current, Archived, the team's folders, Deleted) beside the chosen node's threads; narrower, a
  folder dropdown above the list.
- **Workspace tree.** The Files panel's tree (`apps/web/components/files/workspace-tree.tsx`,
  `file-tree.tsx`): the member's own files (My files) and the projects mounted for them, read from
  the server's manifest (`GET /v1/workspace/files`), refreshed by KOBE-599's events stream.
- **What links a file to a thread today.** Only some kinds of file know their thread:
  - `files` (uploads, attachments, files shared into a conversation) carry `thread_id` and `run_id`;
  - `artifacts` belong to one thread;
  - **workspace files do not:** `workspace_files` is keyed by (team, user, path) and the change
    history records only the actor kind (`user`, `agent`, `admin`), not the thread or run. The
    sandbox pushes every 60 s and after a run, so a push cannot be attributed to one thread.
- **What the server already sees.** Every tool call passes through the server's policy decision
  with its input (`services/server/src/policy`), and the thread's entries keep every tool call
  permanently. The agent's file tools (`read`, `write`, `edit`, `ls`, `find`, `grep`) name their
  path in the input; `bash` names files only inside free-form shell text.

## 2. Proposal in one paragraph

Record a **thread–file link** whenever a thread's run touches a workspace path through a file tool,
an upload or attachment, a shared file, or a project file edit, with how it was touched (read or
written) and when. The Threads panel gets three rails at wide widths: **folders | threads |
workspace**. Hovering or focusing a thread row draws lines from it to the files it used in the
workspace rail (expanding nothing; a file inside a closed folder links to that folder with a
count); hovering or focusing a file draws lines to the threads that used it. The same links are
readable without the lines (a "Files" list in each thread row's details, a "Used in" list on each
file) for keyboard and screen-reader users and narrow widths.

## 3. Links (data)

- **Table** `thread_file_links` (team table, RLS as every team table): `team_id`, `thread_id`,
  `owner_user_id` (whose workspace the path is in), `path`, `access` (`read` | `write`),
  `first_at`, `last_at`, `count`. One row per (thread, owner, path, access); repeated use bumps
  `last_at` and `count`. Project files carry the project (`project_id`, path inside it) instead of
  an owner.
- **Recorded by the server**, never by the sandbox: at the policy decision of an allowed file tool
  call (path normalised to the workspace root; paths outside `/workspace` are ignored), on upload
  or attachment, on a shared file, on a project file save or accepted proposal from that thread.
- **Moves and deletes.** A move (`workspace_moves`) rewrites the path; a deleted file keeps its
  links, shown as "deleted" in the thread's list and absent from the rail.
- **Bash** is not parsed (TFM2).
- **Backfill** once from the threads' stored tool calls (TFM3), recording the same sources.

## 4. Reads (API)

- `GET /v1/threads/{id}/files`: the links of one thread the viewer may read, limited to paths the
  viewer may see (their own workspace, projects they can read); the rest as a count ("2 files in
  a teammate's workspace").
- `GET /v1/workspace/file-threads?path=…` (and a batch form for the visible tree): the threads the
  viewer may read that used the path, newest first, capped.
- `GET /v1/threads/file-links?threads=…`: the links for the visible thread rows in one call, so a
  hover never waits on the network.

## 5. The panel

- **Layout (wide band):** folders (as today) | threads (middle) | workspace rail (right, the same
  tree as the Files panel, read-only here: open, no edit, drag a file onto a thread? see Q6).
  Below about 1,100 px: no workspace rail and no lines, the lists only (TFM4).
- **Hover a thread** (or focus it with the keyboard): lines from the row's right edge to each linked
  file in the workspace rail; written links solid, read links dashed (TFM1); files not visible (closed folder) link to the nearest visible folder with a
  count badge; files scrolled out of view link to an "N more above/below" marker.
- **Hover a file or folder:** lines to the thread rows that used it; threads in other folders of
  the folder tree are counted on that folder ("3 in Archived").
- **Lines** are an SVG overlay over the three rails, redrawn on scroll and resize, in the theme's
  tokens, no animation under `prefers-reduced-motion`. A cap (e.g. 30 lines) with "+N" beyond it.
- **Without hover:** each thread row's details show "Files (N)"; each file's context menu shows
  "Used in (N threads)"; both lists are links (open the file, open the thread).
- **Click (see Q4):** clicking a thread still opens it (today's behaviour); clicking a file opens
  it in the artifact column.

## 6. Permissions and privacy

- A viewer sees links only for threads they may read and files they may see; nothing reveals the
  name of a teammate's file or an unreadable thread (counts only).
- Shared read-only threads show the files only where the viewer can see them (a project file, yes;
  the sharer's own workspace, no).
- Audit: no new audit event (reads only); the table is covered by the cross-team probe suite.

## 7. Out of scope

Lines in the Files panel outside the Threads panel, links to MCP resources or URLs, a graph view of
the whole workspace, parsing shell commands for paths.

## 8. Decisions (Chris, 2026-11-10) and open questions

- **TFM1. Used = read and written**, drawn differently: solid line for a file the thread wrote or
  changed, dashed for one it only read.
- **TFM2. Shell commands are ignored.** Links come only from exact sources (file tools, uploads,
  attachments, shared files, project saves); nothing is guessed from `bash` or from pushes.
- **TFM3. Backfill once** from the stored tool calls of existing threads, so the lines work on day
  one.
- **TFM4. Narrow widths: lists, no lines.** Below the width three rails need (about 1,100 px),
  there is no workspace rail and no lines; each thread shows "Files (N)" and each file "Used in".

Still open:

- **Q4. Hover vs pin.** Hover alone, or also click-to-pin a thread's lines (useful on touch and for
  following many lines)? Recommended: hover and keyboard focus, plus a pin toggle on the row.
- **Q6. Drag between rails.** Out of scope, or drag a file onto a thread to attach it to a new
  message there?
- **Q7. Which workspace.** The right rail shows the viewer's own workspace (My files and their
  mounted projects). Should teammates' shared threads show links into projects only, as §6 says?

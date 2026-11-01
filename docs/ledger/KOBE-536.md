# KOBE-536: Threads panel with two rails (web) (TLF-5)

- **Status:** done (PR #442 merged, main f5a5575c)
- **Branch / worktree:** `kobe-536-threads-panel` in `../Kobe-wt536`
- **Depends on:** KOBE-532 (protocol), KOBE-534 (folders db + server), both on this branch

## Plan

Web only (`apps/web`); protocol and server untouched. Spec `docs/specs/thread-lineage-and-folders.md`
TF5–TF12, §6.

- `lib/chat/folders-api.ts`: the four folder calls and `POST /file`; answers validated with
  `threadFolderSchema` / `threadFoldersResponseSchema` in wire casing, bodies with the request schemas.
- `lib/chat/folder-tree.ts` (pure): placing folders, visible rows, paths, move targets (depth fits),
  the Delete question. `lib/chat/folders-store.ts`: one read per tab, shared by the tree and menus.
  `lib/chat/panel-memory.ts`: chosen node, fold state, per-node group state (memory only, TF12).
- `ChatSession` gains `folders`, `panelMemory` and `file()` (list + thread + folder counts read again,
  other tabs told, as `organize`).
- List adapter: Current reads `/pinned?folder=none` and `?folder=none` (+ shared, archived, trash as
  before); a chosen folder adds `/pinned?folder=<id>` and `?folder=<id>`; duplicates (a shared thread
  filed in the folder) listed once; Load more pages the list on screen (cursor `<folder>:<cursor>`).
  `folderId` travels in `placementCustom`; `groupThreads(…, scope)` groups one node.
- UI: `threads-panel.tsx` (header + grid ≥ 820 px / dropdown below), `folder-tree.tsx` (ARIA tree),
  `folder-node-menu.tsx` (actions + inline editor), `folder-picker.tsx` (phone `<select>`),
  `thread-node-list.tsx` (groups, Archived flat list, Deleted), `components/chat/save-to-folder-menu.tsx`.
- Commands: `save-to-folder` (thread-menu, `/folder`, readOnlySafe), `folder-node-actions`, and a new
  `folder-menu` scope (rename-folder, new-subfolder, move-folder, delete-folder).
- Fake: `lib/chat/testing/fake-folders.ts` (+ `folder_id`, `?folder=`, `/file` in `fake-kobe.ts`).

## Decisions

- **Header menu.** There is no ⋯ beside the title today: `thread-commands.tsx` publishes the open
  thread's menu bindings to the command listings. `save-to-folder` is bound there, so the palette lists
  "Save to folder" and `/folder` works; the row menu labels it "Save to folder…".
- **Inline editors** (new folder, rename, delete confirm, refused move) sit right below the tree (and
  below the phone dropdown), as the Files tree's inline dialogs do; errors are `role="alert"`.
- **"New folder…" in the row's Save submenu** asks the name with `window.prompt` (a menu item can't
  hold a field), creates it at the top level and files the thread there.
- **Tree keyboard:** arrows move focus, Enter/Space/click choose (aria-selected = chosen node), so
  arrowing does not reload lists. Right/Left open/fold; Shift+F10 / Menu key open a folder's ⋯.
- **Counts:** folders use the server's per-member count; Current counts the listed (first-page)
  unfiled, unarchived rows; Archived the listed archived ones; Deleted the Trash list.
- **Folders start folded**, Current folded (Archived hidden) by default; choosing Archived opens it.
- A chosen folder that disappears (deleted here or by another member, seen on the next read) falls back
  to Current. Deleting a folder that holds the chosen node does the same.
- Shared rows are draggable; they also carry `application/x-kobe-shared-thread`, which project headers
  refuse. Archived and Deleted nodes are not drop targets; Current removes from the folder.
- Archive's focus-follow now goes to the Archived node (or Current while folded) instead of the old
  Archived group toggle.
- Empty states: folder with subfolders: "No threads here. Its folders are in the tree."; otherwise a
  hint to Save or drag; Deleted: "Trash is empty."

## Open questions (for Chris or the coordinator)

- Current's count is page-limited (the server sends no count for unfiled threads). Fine for v1?
- Opening a filed thread then switching nodes relies on assistant-ui re-fetching the controlled thread
  when it leaves the list (as search hits beyond page 1 already do); covered by a test, worth a look in
  the KOBE-537 browser check.

## Evidence (acceptance criteria → test or command output)

Tests were written with the code rather than strictly first (the panel's structure decided the
fixtures); every criterion below has a test.

- ac-1: `components/shell/threads-folders.test.tsx` "the tree and the folder views" (order + counts,
  folder groups incl. Shared with me, Current excludes filed/archived, Archived path + Unarchive back to
  its folder, empty folder with subfolders, keyboard); Deleted: `threads-panel.test.tsx` "Trash (ac-2)".
- ac-2: `threads-folders.test.tsx` "folder actions" (new inline + `folder_name_taken`, rename, depth
  blocker, move + `folder_too_deep` inline, delete with confirm).
- ac-3: `components/shell/threads-filing.test.tsx` "Save to folder" (row menu own + shared, New folder…,
  palette, drag onto node / Current, shared row refused by a project header, Remove from folder,
  announcement, focus re-read).
- ac-4: `threads-folders.test.tsx` "on a phone". ac-5: `threads-filing.test.tsx` "search".
- ac-6: `threads-folders.test.tsx` "the chosen node".
- Units: `lib/chat/folder-tree.test.ts`, `folders-api.test.ts`, `panel-memory.test.ts`,
  `thread-groups.test.ts`, `thread-list-adapter.test.ts`.
- Updated for the tree: `threads.test.tsx`, `thread-organize.test.tsx`, `thread-row-trash.test.tsx`,
  `workspace-rail.test.tsx`, `thread-menu.test.tsx`, `threads-panel.test.tsx`.

## After the merge

- gate1 run of the KOBE-537 specs (2026-11-01): deleting a folder while Current was chosen left its
  threads off screen until the next list read (only the folder store refreshed). Fixed with the
  KOBE-537 PR: `session.removeFolder` re-reads the thread list and posts to the other tabs.

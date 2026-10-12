# KOBE-198: A2: Workspace rail: Threads over Files, divider, groups, collapsed state

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in progress (branch pushed; PR held: over the ~600-line guide, split proposed)
- **Branch / worktree:** `kobe-198-workspace-rail` in `../Kobe-wt198`
- **Depends on:** KOBE-197 (shell), KOBE-203 (IconAction, registry), KOBE-205 (column scroll)

## Plan

`components/shell/workspace-rail.tsx` replaces `thread-sidebar.tsx` and the Files side panel:
team-name header (CE2), Threads over Files with a divider, 280 px or 48 px collapsed (CE5).

## Decisions

- **State:** `rail-state.tsx` (`RailProvider`) holds collapsed and Threads' share (60%, clamped
  20–80%) in memory. Slot comment for A6 (KOBE-202) to load/save them per user.
- **Width:** `shell.module.css` sets `--kobe-rail-width` 280 px, 48 px via
  `.grid:has(> .rail > [data-collapsed])`; no prop threading through `ShellGrid`.
- **Collapsed:** exactly three IconActions: `new-thread` (also expands), `show-threads`,
  `show-files` (new registry entries); the two `show-*` expand and focus their section.
  `toggle-rail` is now "Collapse the rail" (`PanelLeftCloseIcon`). `files-close` removed.
- **Bar Files (row two):** kept per CE3; it now reveals the rail's Files section (`FilesButton`).
- **Narrow screens:** until A5 (KOBE-201), the rail starts collapsed under 48rem and folds when a
  thread opens (replaces the old fold toggle). Collapsed is a 48 px row of the three icons there.
- **Divider:** `role=separator`, `aria-valuenow` = Threads' %, `aria-controls` the Threads
  section; pointer drag (captured) and Arrow/Page/Home/End. Grid rows set inline, rounded.
- **Groups:** `lib/chat/thread-groups.ts` (pure). Placement rides in assistant-ui's item
  `custom` (`metadataOf` → `{projectId, scheduled, shared}`), which replaced the session's
  scheduled-thread set. Order Pinned → projects (by name) → Your threads → Scheduled → Shared with
  me → Archived → Trash; empty groups never render. Precedence: shared > scheduled > project.
  Pinned/Archived have no data until Phase C (no server fields added). "Shared with me" uses the
  existing `readOnly` flag (the main list rarely carries such threads today).
- Rendering: `ThreadListPrimitive.ItemByIndex` per grouped thread (keyed by item id) inside
  `ThreadListPrimitive.Root`; group headers are disclosure buttons. Archived and Trash start
  collapsed; the others open. Project names: one `GET /v1/projects?include_archived=true` when
  any listed thread has a project; unknown ids show "Project".
- **Files:** `FileBrowser` mounted as-is at `/workspace` (uploads/, outputs/, projects/ come from
  the listing). The sandbox wake now waits until the member uses Files (focus or pointer in the
  section, or a reveal), so a chat page load never wakes a sandbox.
- Wording: section "Threads", ungrouped "Your threads", hints say "Threads".

## Open questions (for Chris or the coordinator)

- Size: ~930 added / ~410 removed non-test lines (one move: `ThreadItem`, 98 lines). Proposed
  split: (1) rail shell + divider + collapsed icons + Files section + old panel removed, with the
  flat thread list; (2) thread groups (`thread-groups.ts`, `custom` placement, `rail-threads`).

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/shell/workspace-rail.test.tsx` "rail (ac-1)" (team name, sections, collapse
  and the three icons) and "divider (ac-1)" (keyboard, clamping, pointer drag).
- ac-2: same file "thread groups (ac-2)" (projects by name, Your threads, Scheduled, Trash, no
  Pinned/Archived/Shared); `lib/chat/thread-groups.test.ts` (full order incl. Shared, malformed).
- ac-3: `components/shell/rail-files.test.tsx` (list, folders, download, upload, delete, read-only,
  errors, lazy wake, bar Files focus, artifact column empty).
- Web suite 89 files / 801 tests, typecheck, eslint, prettier, hygiene, Site wording: green.

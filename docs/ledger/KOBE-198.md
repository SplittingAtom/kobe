# KOBE-198: A2: Workspace rail: Threads over Files, divider, groups, collapsed state

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #258; one PR, the coordinator chose no split)
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
- **Files:** `FileBrowser` at `/workspace` (uploads/, outputs/, projects/ come from the
  listing). A chat page load neither lists nor wakes; see review round 1.
- Wording: section "Threads", ungrouped "Your threads", hints say "Threads".

## Review round 1 (`/code-review medium`, 10 findings, all fixed)

- Collapse no longer unmounts: header and sections stay mounted under `hidden`; the three icons
  show beside them. Groups, the Files folder and uploads survive; no re-wake on expand.
- New in the collapsed rail keeps the fold state (coordinator's call over "the three icons expand
  it"); Show threads / Show files expand and focus their section.
- Files: nothing is listed or woken until "Open files", Show files or the bar's Files; each of
  those and the new `refresh-files` IconAction lists again and re-wakes (`FileBrowser wakeKey`).
- A thread created since the last list read takes its placement from the seeded summary
  (`session.peek`): assistant-ui 0.15.26 keeps only `remoteId`/`externalId` from `initialize`, so
  extra fields there would be dropped.
- Project names: re-read on window focus and when the listed projects change, keyed by team
  (another team's never show); a failed read logs a warning and shows "Project names could not
  be loaded."
- Narrow default applied in an effect after mount (first render is the same everywhere).
- Divider: measured against the sections minus its own row; a drag writes the rows and
  `aria-valuenow` directly and commits once on release. One `sectionRows()` helper rounds both.

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/shell/workspace-rail.test.tsx` "rail (ac-1)" (team name, sections, collapse
  and the three icons) and "divider (ac-1)" (keyboard, clamping, pointer drag).
- ac-2: same file "thread groups (ac-2)" (projects by name, Your threads, Scheduled, Trash, no
  Pinned/Archived/Shared); `lib/chat/thread-groups.test.ts` (full order incl. Shared, malformed).
- ac-3: `components/shell/rail-files.test.tsx` (list, folders, download, upload, delete, read-only,
  errors, lazy wake, bar Files focus, artifact column empty).
- Review fixes: `rail-files.test.tsx` (deferred listing, re-wake per ask, kept folder through
  collapse), `workspace-rail.test.tsx` (New keeps it collapsed, narrow after mount, drag commit,
  new project thread grouped before reload, project-name error and focus re-read).
- Web suite 89 files / 805 tests, typecheck, eslint, prettier, hygiene, Site wording: green.

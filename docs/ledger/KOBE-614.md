# KOBE-614: Threads panel polish (spacing, icons, row pill, resizable workspace rail)

- **Status:** ready for review (agent done; not pushed)
- **Branch / worktree:** `kobe-614-threads-polish` in `../Kobe-wt614` (from main `1ceb0b5a`)
- **Depends on:** KOBE-610..613 (the three-rail Threads panel, spec `docs/specs/thread-file-map.md`)

## Request (Chris, 2026-11-11)

Less white space right of names; missing icons (row pin, the opener of Current); no "Files (N)"
button under each thread; a pill on row hover/focus; trash and ⋯ right after the name; the
workspace rail resizable; the files tree filling the rail.

## What changed

1. **Columns** (`threads-panel.tsx`, `file-rail-resize.tsx`): the wide grid is
   `200px | 1px | var(--kobe-threads-col) | 1px | var(--kobe-file-rail-col)`. Default: threads
   `fit-content(28rem)` (at least 12rem), rail `minmax(240px,1fr)`, so the thread column hugs its
   titles and the rail takes the rest. A dragged width: threads `minmax(12rem,1fr)`, rail
   `minmax(240px,<w>px)`. At three rails the panel fills its height; folders, threads and the rail
   each scroll on their own (the overlay already clips lines to scrolled ancestors).
2. **Icons.** (a) `LinePin`: revealed by `group-hover/row` and `group-focus-within/row`, always
   on touch screens (`pointer-fine:` only hides it with a mouse) and always when pinned; the
   thread's pin now sits in the row (`ThreadListItemPrimitive.Root`, which has `group/row`), file
   rows already had it. (b) **Found:** the folder tree's chevron button (Current's opener, and a
   folder with subfolders) had no padding/border reset, so the chat's base rule for Kobe's own
   buttons (`app/chat-global.css`: `padding: 0.25rem 0.75rem`, 1 px border, background) applied
   to its 14 px box; Chromium clipped the chevron away, leaving an empty bordered pill (reproduced
   in headless Chromium). Fixed with `p-0 border-0 bg-transparent` (+ unit assertion). Same reset
   on the panel's other bare buttons (+ New folder, the files list, rail "Try again").
3. **Files (N)** under the title removed. New `thread-files` command (scope `thread-menu`,
   `FilesIcon`): the row's ⋯ menu shows "Files (N)…" when the thread has links; it opens the list
   under the row and focuses the first file; Escape closes it (focus back on ⋯), the item then
   reads "Hide files (N)". `ThreadRowMenu` takes `extra` bindings. Trash rows (no ⋯ menu) no
   longer show a files list.
4. **Pill:** `.panelRow` in `chat.module.css` (Threads panel only, via the `ThreadFileMap`
   context): `border-radius: 9999px`, `var(--accent)` on `:hover` / `:has(:focus-visible)`.
5. **Inline icons:** the panel row is `width: fit-content; max-width: 100%`, the title
   `flex: 0 1 auto`, so pin, trash and ⋯ follow the name; long names truncate, icons stay.
6. **Resize** (`file-rail-resize.tsx`): `useSplitter` (as the Workbench editor, `reversed`), on
   the divider between threads and rail; keys, Enter/double-click reset; saved server-side as
   `threads_file_rail_width` (protocol bounds 240..8192, `@kobe/protocol` + web preferences);
   max keeps folders + 12rem of threads. Lines redraw via the overlay's ResizeObserver.
7. **Files tree fills the rail:** the rail section is `flex-1 min-h-0 overflow-auto` (was
   `max-h-[70vh] self-start`).

## Tests

- `threads-file-map.test.tsx`: Files (N)… menu item, focus/Escape, Hide files, pin on the row,
  no item without links, keyboard resize saves 424 and Enter resets, saved width applied.
- `threads-folders.test.tsx`: Current's chevron has the reset classes and its svg.
- `ui-preferences.test.ts`: `threads_file_rail_width`.
- Browser spec `thread-file-map.spec.ts`: pin on the row, keyboard resize, Files (N)… via the
  menu (wide, narrow, shared). Not run here (coordinator, after the gate1 deploy).

## Open questions

- 2b is my reading of "the icon for opening the current threads" (Current's chevron); confirm
  with Chris after the deploy.
- The spec text (§5, TFM4) still says "Files (N)" under the row; left as is (decisions final).

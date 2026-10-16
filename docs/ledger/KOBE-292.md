# KOBE-292: Rail and file browser row menus; rename moves to the conversation header

- **Status:** committed on `group-3-phase-c-org` (ticket group G3, Phase C; no PR of its own)
- **Branch / worktree:** `group-3-phase-c-org` in `../Kobe-g3`
- **Depends on:** KOBE-203 (command registry), KOBE-217 (Regenerate with), KOBE-281/282 (portals,
  theme tokens), KOBE-215 (`threads.title_locked`, migration 0095). KOBE-220 builds on the menu.

## What changed

- **One menu component:** `components/ui/action-menu.tsx` (`ActionMenu`), Radix DropdownMenu on
  the menu button pattern (Enter/Space/arrows open, arrows move, ArrowRight opens a submenu, Escape
  closes and returns focus to the ⋯ button). Portalled with `chatPortalContainer()` and marked
  `data-kobe-portal`; controlled, so the portal finds the chat root on open even when the row first
  rendered before it. Colours are `app/theme.css` tokens (`bg-background`, `bg-muted`,
  `text-destructive`), so both themes work. The button shows on row hover/focus/open
  (`ROW_REVEAL`, rows carry `group/row`) and always below 768 px or with a coarse pointer.
- **Registry-driven:** two new scopes in `lib/shell/commands.ts`, `thread-menu` (copy-thread,
  regenerate-thread, regenerate-thread-with, trash-thread "Delete") and `file-menu` (open-file,
  download-file, copy-file-path, delete-file). `lib/shell/menu.ts` `menuItems(scope, bindings)`
  lists the commands a row binds, in registry order. **KOBE-220:** register Pin/Archive/Move with
  scope `thread-menu` and bind them in `components/chat/thread-row-menu.tsx`; nothing else.
  Bindings carry `blocker` (unavailable: stays focusable, `aria-disabled`, reason as `title` and
  `aria-describedby`), `choices` (submenu), `destructive`, `movesFocus` (runs after the menu's
  focus trap is gone, keeps the focus it moved: the file Delete confirm).
- **Thread rows** (`thread-item.tsx`, `thread-row-menu.tsx`): the rename and Trash icons are gone.
  While the menu is open it holds the thread's controller (`session.acquire`), so its state decides
  what is offered.
  - Copy: the branch on screen as Markdown (`lib/chat/thread-menu.ts` `threadMarkdown`: `# title`,
    then `## You` / `## Assistant` with text parts only; reasoning, tool calls and notices are
    left out), without opening the thread. `lib/clipboard.ts` hands Safari a promised
    `ClipboardItem` when the text is still loading.
  - Regenerate / Regenerate with: open the thread (`switchTo`), then the last answer's branch point
    (`lastAnswerPoint` = `branchPoint` of its prompt) goes through `controller.send` /
    `controller.regenerateWith`, the answers' own paths. The submenu is `modelChoices` +
    `teamDefaultLabel` with "(current)", hidden for a pinned agent, as on answers. Disabled with the
    reason (`regenerateBlocker`) while a run is going, queued or being sent, a model change is in
    flight, in Trash, read-only, or with no answer yet.
  - Delete: Move to Trash after `window.confirm` ("Move “X” to Trash? You can restore it from Trash
    for 30 days."). There was no confirm before (only Delete forever had one); added because a menu
    "Delete" reads more final than the old Trash icon.
  - Trash rows keep Restore and Delete forever as icons (no Copy/Regenerate there).
- **Header rename** (`components/chat/thread-title.tsx`): the name with a pencil (chat shell only,
  the owner's saved thread out of Trash). Enter saves through `aui.threadListItem.rename` (the
  existing `PATCH /v1/threads/{id}`), so the rail updates at once; Escape or leaving the field
  cancels; focus returns to the pencil. The header now prefers the list's title over the
  summary's (the list updates on rename, the summary on the next read).
- **Title lock:** `services/server/src/threads/repository.ts` `updateThread` sets `title_locked`
  with every title change: true for a name, false when cleared (clearing hands the name back to
  auto-titling). The epilogue already skips locked titles (KOBE-234). `title_locked` is not in the
  summary yet; KOBE-219 adds it.
- **File browser rows** (`components/files/file-browser.tsx`): one ⋯ menu (32 px, KOBE-269) with
  Open (folder: navigate; file: the artifact column), Download (files), Copy path (the
  workspace-relative path, e.g. `notes/todo.md`, the agent's working directory), Delete (the
  existing inline confirm, not for read-only paths). A cancelled delete returns focus to the row's
  ⋯ button. **Rename/Move: not offered.** `/v1/workspace/files` has GET, POST (upload) and DELETE
  only; a follow-up needs a server move/rename route (and sandbox sync semantics) first.

## Open questions (for Chris or the coordinator)

- Copy format: Markdown with `#` title and `##` role headings, text parts only. Chris may want
  tool calls or reasoning included; it is one function (`threadMarkdown`).
- Copy reads the thread as the controller does (up to its page cap); a thread longer than that
  copies what was read.
- Delete-to-Trash now confirms (see above); say if the old one-click Trash should stay.

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/chat/thread-menu.test.tsx` (no row icons; items; Copy as Markdown without
  opening; Regenerate opens and sends from the branch point; Regenerate with lists models and
  switches first; disabled with the reason while running; Delete confirms). Pure parts:
  `lib/chat/thread-menu.test.ts`, `lib/clipboard.test.ts`. `threads.test.tsx` and
  `breakpoints.test.tsx` moved to the menu (Escape in the drawer closes the menu, not the drawer).
- ac-2: `components/chat/thread-title.test.tsx` (Enter saves and the rail follows, focus back on
  the pencil; Escape cancels; empty/unchanged sends nothing; no pencil for new, read-only, Trash);
  `services/server/src/threads.db.test.ts` "a rename locks the title…" (failed before the change).
- ac-3: `components/shell/rail-files.test.tsx` (menu items per row, read-only rows without Delete,
  Open, Copy path to the clipboard, Delete confirm takes focus, cancel returns it),
  `components/files/file-viewer.test.tsx` (32 px button, Download from the menu).
  Playwright: `e2e/browser/tests/row-menus.spec.ts` (both menus by keyboard in light and dark,
  painted per theme, Escape returns focus; header rename updates the rail; Copy as Markdown via
  the clipboard; file Delete confirm). Typechecks and lists (`playwright test --list`); it cannot
  pass on gate1 until G3 is deployed there.
- ac-4: `components/ui/action-menu.test.tsx` (menu button pattern, arrows, Escape returns focus,
  unavailable items focusable with their reason, submenu by ArrowRight, portalled into the chat
  root with `data-kobe-portal`); `lib/shell/menu.test.ts` (registry order, unbound left out);
  `components/ui/popup-portals.test.ts` still green.

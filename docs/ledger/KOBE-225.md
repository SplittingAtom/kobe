# KOBE-225: C7 command palette and twelve shortcuts (CE23)

- **Status:** done on branch, awaiting review (no PR: group G4)
- **Branch / worktree:** `group-4-composer` in `../Kobe-g4`
- **Depends on:** KOBE-224 (command bindings), KOBE-203 (registry), KOBE-223 (file search),
  KOBE-221 (shared threads)
- **Migrations / server / protocol / dependencies:** none (Radix Dialog from `radix-ui`, already in)

## The twelve (CE23, fixed, not customizable; `Mod` = Cmd on macOS, Ctrl elsewhere)

| Key             | Command id                        | What it runs                                                                                                     |
| --------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Mod+K           | `command-palette`                 | opens the palette (Mod+K again closes it)                                                                        |
| Mod+N           | `new-thread`                      | `aui.threads.switchToNewThread()`                                                                                |
| Mod+B           | `toggle-rail`                     | `rail.toggle(!collapsed)`, as the rail's button (saved when docked)                                              |
| Mod+Shift+F     | `files`                           | `rail.reveal("files")`, as the bar's Files                                                                       |
| Mod+Shift+A     | `toggle-artifacts`                | hides/shows the artifact column (tabs kept; the sheet under 820 px); with no tab open, opens the newest artifact |
| Mod+Shift+D     | `detail`                          | the Detail toggle                                                                                                |
| Mod+.           | `stop`                            | `stopBinding` (steering panel's Stop)                                                                            |
| Mod+Shift+Enter | `steer`                           | Steer now (`useSteer`); the input still handles it itself during a run                                           |
| Mod+Shift+E     | `edit-last-message`               | `beginEdit()` on the last user message on screen                                                                 |
| Mod+[ / Mod+]   | `previous-thread` / `next-thread` | the rail's order (Pinned → projects → yours → Scheduled → Shared), no Archived/Trash, no wrap                    |
| Mod+/           | `focus-composer`                  | focuses the message box                                                                                          |

Plus `?` (`keyboard-shortcuts`, the sheet) and Up arrow in the composer (`edit-last-message`).

## Design

- **One registry, one rule.** New commands in `lib/shell/commands.ts` (scope `app` for
  keyboard/palette-only ones; `palette: true` lists the theme). `edit` lost its shortcut: the last
  message's Edit tooltip shows `edit-last-message`'s. `SHORTCUTS_BOUND = true`, so every
  IconAction with a key shows it in its tooltip and `aria-keyshortcuts`; the composer carries
  `aria-keyshortcuts` for Mod+/.
- **Bindings** (`useBindCommands`): `AppCommands` (rail, files, artifact column, detail, theme,
  previous/next), `Composer` (focus, steer), `ThreadCommands` (edit last; a draft binds it
  blocked), `CommandPalette` and `ShortcutSheet` (their own open). `commandBlocker` (was
  `blockerOf` in `slash.ts`) is the one rule for the `/` menu, the palette and the keys.
- **Keys** (`components/shell/shortcut-keys.tsx`, pure half `lib/shell/shortcuts.ts`): one
  document keydown listener, bubbling, skips `defaultPrevented` (Escape and Enter keep their
  owners) and repeats. Not in text fields (except Mod+K anywhere, Mod+. and Mod+Shift+Enter in
  the composer), not while `isComposing`/keyCode 229, not while a modal dialog is open (role
  dialog with `aria-modal` or Radix `data-state=open`, alertdialog: palette, confirms, the rail
  drawer, the artifact sheet), not when an iframe has the focus. Letters also match by `code`
  (non-Latin layouts); punctuation ignores Shift. A refused key shows "Label: reason" in a
  visible status line for 4 s (role=status), and does nothing.
- **Palette** (`components/shell/command-palette.tsx`, pure half `lib/shell/palette.ts`): Radix
  Dialog (focus trap; focus goes back to what had it, then the picked action runs, so an action
  that moves focus keeps it); input `role=combobox` with `aria-controls`/`aria-activedescendant`,
  a listbox of groups Actions, Threads, Files. Actions: every command with a `/` word, shortcut,
  href or `palette`, registry order, navigation last (consoles via `useOpenConsoles`), blocked
  ones disabled with the reason. Choices (Regenerate with, Move, Share, Model) are a second step;
  Backspace on empty or Escape goes back. Threads: `GET /v1/threads?q=`; files:
  `GET /v1/workspace/files/search` (invisible-character names left out, as `@`); both debounced
  250 ms, 8 per group, newest query only (`use-palette-search.ts`). A reader's palette blocks
  all but read-only-safe actions (layout actions are read-only-safe).
- **Up arrow** (composer `onKeyDown`): only with no modifier, no IME, value `""`, caret 0 and no
  open trigger popover; runs the bound `edit-last-message` when not blocked, else does nothing
  silently (no refusal toast for a stray arrow).
- `useNavigate` moved to `components/shell/use-navigate.ts` (slash menu and palette);
  `useListedThreads` extracted from the rail for the previous/next order.

## Departures and known limits

- **Mod+N:** Chrome and Firefox reserve Ctrl/Cmd+N in a normal tab (new window) and never pass it
  to the page; it works in an installed app window. New conversation stays one Mod+K away.
- **Previous/next order** sorts project groups by id-equal label ("Project"), not by project
  name as the rail does: with two or more projects the step order between project groups may
  differ from the rail's. Inside a group it matches.
- **Iframes:** artifact previews are sandboxed and cross-origin, so their keys never reach the
  page; the handler also ignores a press while an iframe has the focus. Shortcuts resume once
  the member clicks back into the conversation (the sheet says so).
- **Mod+Shift+A:** the column hidden by the key stays hidden for that thread until shown, or an
  artifact is opened; an agent's auto-open does not show it again.

## Open questions

- None blocking.

## Evidence

- ac-1: `components/shell/command-palette.test.tsx` (11: dialog/combobox ARIA, focus trap and
  return, every registered action listed with key or reason, run by words, blocked says why and
  stays open, Regenerate with choices + back, edit keeps focus, thread by title, file opens in
  the column, one debounced request each, navigation via the router, reader blocked);
  `lib/shell/palette.test.ts`.
- ac-2: `components/shell/shortcut-keys.test.tsx` (18: each of the twelve, refusals, the `?` sheet
  lists exactly 12 in order and returns focus, tooltips' `aria-keyshortcuts`, not in fields, IME,
  dialogs, iframes or after another handler); `lib/shell/shortcuts.test.ts`;
  `components/shell/icon-action.test.tsx`; `lib/chat/thread-groups.test.ts` (order, ends).
- ac-3: `components/chat/edit-last.test.tsx` (7: opens the last question focused; not with text,
  in the `/` or `@` menus, with modifiers or IME, during a run, or in a draft).
- Browser (gate1, later): `e2e/browser/tests/command-palette.spec.ts` (palette runs New
  conversation, opens a thread by a word of it, `?` sheet lists 12).
- Commands: `pnpm format:check`, `pnpm lint`, web `typecheck`, web vitest (151 files, 1444 tests)
  green.

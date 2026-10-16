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
  owners) and repeats. Every Mod chord runs from the message box (review M1: the focus is
  usually there) and is `preventDefault`ed, so Cmd+[ never goes Back; from other fields (search,
  edit box) only Mod+K; a bare `?` never from a field. Not while `isComposing`/keyCode 229, not
  while a modal dialog is open (role dialog with `aria-modal` or Radix `data-state=open`,
  alertdialog: palette, confirms, the rail drawer, the artifact sheet; also non-modal Radix
  popovers such as Move or the gauge, on purpose: conservative, review N4), not when an iframe
  has the focus. Shift must match exactly (Cmd+Shift+[ / ] stay the browser's tab keys), except
  `/` and `?`, which some layouts type with Shift. The typed character decides when it is
  printable ASCII (Dvorak, AZERTY); `code` is the fallback only for non-Latin keys (review S1,
  S2). A refused key shows "Label: reason" in a visible status line for 4 s (role=status).
- **Alias:** New conversation also answers Mod+Shift+O (`alias` on the command; tooltips,
  `aria-keyshortcuts` and the sheet show it first), since browsers keep Mod+N for a new window
  outside an installed app (review S3).
- **Palette** (`components/shell/command-palette.tsx`, pure half `lib/shell/palette.ts`): Radix
  Dialog (focus trap; focus goes back to what had it, then the picked action runs, so an action
  that moves focus keeps it); input `role=combobox` with `aria-controls`/`aria-activedescendant`,
  a listbox of groups Actions, Threads, Files. Actions: every command with a `/` word, shortcut,
  href or `palette`, registry order, navigation last (consoles via `useOpenConsoles`), blocked
  ones disabled with the reason. Choices (Regenerate with, Move, Share, Model) are a second step;
  Backspace on empty or Escape goes back. Threads: `GET /v1/threads?q=`; files:
  `GET /v1/workspace/files/search` (invisible-character names left out, as `@`); both from 2
  characters, debounced 250 ms, 8 per group, aborted (`AbortController` through `apiRequest`)
  when a newer query replaces them, cached per query while open, paused 10 s after a 429; no rows
  while the next answers load, so a fast Enter never opens an older query's result (review S4)
  (`use-palette-search.ts`). A reader's palette blocks
  all but read-only-safe actions (layout actions are read-only-safe). Reader state comes from
  `useThreadReadOnly` (`threadReadOnly(custom, summary)`, the KOBE-224 rule), so a deep link to a
  shared thread the list has not shown counts too (review S6).
- **Up arrow** (composer `onKeyDown`): only with no modifier, no IME (`isComposing` or Safari's
  keyCode 229), value `""`, caret 0 and no
  open trigger popover; runs the bound `edit-last-message` when not blocked, else does nothing
  silently (no refusal toast for a stray arrow).
- **Previous/next** follow the rail exactly: `ThreadGroupsProvider` (`components/shell/thread-groups.tsx`)
  reads the listed threads, Trash and project names once and groups them; the rail and the
  stepper both use it (review M2). Folded groups are stepped through; Archived and Trash are not.
- **Artifact column** hidden with Mod+Shift+A stays mounted (`data-hidden` on the grid's column,
  CSS `display: none`), so previews keep their state (review S5).
- `useNavigate` moved to `components/shell/use-navigate.ts` (slash menu and palette).

## Departures and known limits

- **Mod+N:** Chrome and Firefox reserve Ctrl/Cmd+N in a normal tab (new window) and never pass it
  to the page; it works in an installed app window. Mod+Shift+O is its alias everywhere (the sheet
  says so).
- **Browser chords** (Ctrl+Shift+A/D/E, Cmd+.) are not on the browsers' reserved lists; still to
  check by hand in Chrome, Firefox and Safari on gate1.
- **Iframes:** artifact previews are sandboxed and cross-origin, so their keys never reach the
  page; the handler also ignores a press while an iframe has the focus. Shortcuts resume once
  the member clicks back into the conversation (the sheet says so).
- **Mod+Shift+A:** the column hidden by the key stays hidden for that thread until shown, or an
  artifact is opened; an agent's auto-open does not show it again.

## Open questions

- None blocking.

## Evidence

- ac-1: `components/shell/command-palette.test.tsx` (13: + fast Enter after typing, 2-letter
  minimum and aborted requests; dialog/combobox ARIA, focus trap and
  return, every registered action listed with key or reason, run by words, blocked says why and
  stays open, Regenerate with choices + back, edit keeps focus, thread by title, file opens in
  the column, one debounced request each, navigation via the router, reader blocked);
  `lib/shell/palette.test.ts`.
- ac-2: `components/shell/shortcut-keys.test.tsx` (33: each of the twelve on the page and in the
  composer, default prevented; the alias; refusals; a reader's refusals; previous/next with two
  projects named against recency; the `?` sheet lists exactly 12 in order and returns focus;
  tooltips' `aria-keyshortcuts`; only Mod+K from other fields; Shift+[ / ] left alone; IME,
  dialogs, iframes, another handler first); `lib/shell/shortcuts.test.ts`;
  `components/shell/icon-action.test.tsx`; `lib/chat/thread-groups.test.ts` (order, ends).
- ac-3: `components/chat/edit-last.test.tsx` (7: opens the last question focused; not with text,
  in the `/` or `@` menus, with modifiers or IME, during a run, or in a draft).
- Browser (gate1, later): `e2e/browser/tests/command-palette.spec.ts` (palette runs New
  conversation, opens a thread by a word of it, Mod+B and Mod+[ from the composer, `?` sheet
  lists 12).
- Commands: `pnpm format:check`, `pnpm lint`, web `typecheck`, web vitest (151 files, 1467 tests)
  green.

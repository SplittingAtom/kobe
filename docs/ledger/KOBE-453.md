# KOBE-453: Threads move from the rail into a Threads panel (active threads + Trash)

- **Status:** in review (Sonnet), committed on `group-11a-panels`, not pushed
- **Branch / worktree:** `group-11a-panels` in `../Kobe-g11a` (G11a: 452, 453, then 448)
- **Depends on:** KOBE-452 (panel framework), KOBE-419 (rail top line), KOBE-220/221/292 (rows)

## Decisions (Chris 2026-10-20, followed)

- The Threads panel is KOBE-452's large centred overlay; the rail after this is Files (and Apps)
  only (KOBE-448 makes that one tabbed section).

## Design

- **Address:** `/threads` (`lib/shell/panels.ts`, `app/threads/page.tsx` renders nothing). It needs
  the thread list (assistant-ui runtime), so `ChatWorkspace` renders this one panel itself
  (`WorkspacePanel` + `ThreadsPanelContent`); the other panels stay at `ChatApp`'s top level.
- **Content** (`components/shell/threads-panel.tsx`, was `rail-threads.tsx`): a title search (case
  and accents ignored; matches open their groups, Trash included; "No threads match"), Export my
  conversations, the groups with counts and activity dots, Trash collapsed by default (Restore,
  Delete forever), Load more. Rows are the rail's: same `THREAD_ITEM`/`TRASH_ITEM`, ⋯ menu,
  keyboard, hover card, drag onto a project header.
- **Choosing closes it:** any switch of the thread on screen while it is open (a title, Regenerate,
  Make a skill from this) replaces the panel's entry with `/?thread=<id>`, so Back returns to the
  conversation before; a click on the thread already open closes it too.
- **Rail:** top line = team, New conversation, Threads (opens the panel, `aria-haspopup`), Files
  toggle, Team console, collapse. Collapsed strip: team, New, Show threads (panel), Show files,
  Show apps. The Files toggle now shows/hides the section freely (stored `rail_panels`: "both"/
  "files" shown, "threads" hidden; no protocol change). The Threads/Files divider and the client's
  `threads_share` use are gone (`rail-divider.tsx` deleted; the stored value is no longer read).
  The phone's drawer button opens the drawer on Files without listing them.
- Thread list errors show at the top of the rail as well as in the panel (they were only in the
  rail's Threads section).
- **Router outside Next:** `ChatApp` falls back to `window.history` for its route (tests), and gives
  the rail `OpenPanelContext` (route push) for the Threads buttons.

## Shared files touched

- `components/chat/chat-app.tsx` (Threads panel, history route, OpenPanelContext; no composer code),
  `components/chat/testing.tsx` (`openThreads`, `closeThreads`, `threadGroup`; `composer()` closes
  the panel first; `openRowMenu` opens it for thread rows). `commands.ts` untouched.

## Open questions

- With Files hidden the expanded rail shows only its top line. Collapse instead? (448 may settle it.)
- Search filters loaded titles; the bar's search still searches the server (content, `?q=`).

## Evidence

- ac-1, ac-5: `components/shell/threads-panel.test.tsx` (opens at /threads over an inert workspace,
  counts, Escape and focus back; search; choosing closes, Back returns; current thread; deep
  link over the last thread; phone drawer); `workspace-rail.test.tsx` groups in the panel.
- ac-2: threads-panel "Trash"; `threads.test.tsx` Trash restore/delete.
- ac-3: `thread-menu`, `thread-organize` (drag onto a project), `thread-share`,
  `thread-activity`, `breakpoints` (row menu Escape in the panel) all run against the panel.
- ac-4: `rail-header.test.tsx` (New left of Threads, collapsed strip, Files toggle saved),
  `threads-panel` "New conversation"; browser `rail-header.spec.ts`, `row-menus`, `organize`,
  `share`, `status-cues`, `auto-title`, gate5 U17 (Files toggle replaces the divider) updated;
  `e2e/browser/tests/support/chat.ts` `openThreads`/`closeThreads`.

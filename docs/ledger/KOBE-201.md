# KOBE-201: A5: Breakpoints, yield order, overlay sheet and single-column layout

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #)
- **Branch / worktree:** `kobe-201-breakpoints` in `../Kobe-wt201`
- **Depends on:** KOBE-198 (rail), KOBE-200 (artifact tabs), KOBE-202 (layout preferences)

## Plan

CE7 table and CE8 single column on the A1–A6 shell. `lib/shell/layout.ts` holds the breakpoints
(768 / 820 / 1100 px) and the yield order as arithmetic (`layoutAt`). `shell.module.css` lays it
out with media queries on the same numbers. `components/shell/shell-band.tsx` gives React the
band (`wide` / `medium` / `overlay` / `single`) from `matchMedia`, followed on `resize`.

## Decisions

- **One band source.** `ShellBandProvider` sits at the chat root. It is `wide` on the server and on
  the first client render, so the markup matches; the real band is read after mount. Outside a
  provider (builder test pane) it is always `wide`. `isNarrowScreen()` is gone.
- **Rail (CE7 step 1).** The member's choice (KOBE-202's stored value) is the rail's state on
  wide windows only. Below 1100 px the grid gives the rail 48 px whatever was chosen. Expanding it
  there opens a **modal drawer** (280 px, `role=dialog`, `aria-modal`). The drawer is never saved
  and never touches the choice, so the choice comes back above 1100 px (ac-2). A resize across
  1100 px closes the drawer. `applyRailCollapsed` no longer forces "collapsed" on narrow screens:
  the band does that on screen without touching the stored value.
- **Artifact column (CE7 steps 2–3).** ≥ 820 px: a column within both floors, with the resize
  handle (previously ≥ 1100 px only). Between 820 and 1100 px the rail is already 48 px, so the
  column shrinks toward 360 while the conversation keeps 400. 768–820 px: a **sheet over the
  conversation** (`clamp(360px, 50%, 100% - rail)`, non-modal, Back control). < 768 px: a
  **full-screen modal sheet** with Back and the existing horizontal tab strip.
- **Sheet visibility.** The sheet shows when the member opens an artifact. Back or Escape hides it
  and keeps the tabs. Closing the last tab or switching threads also hides it. The agent's
  auto-opens add a tab but don't cover the conversation (on a phone, a full-screen sheet popping
  up mid-run would hide the stream); the run notice's Open button shows it. On column widths the
  sheet state is ignored. Escape in a column still closes the active tab (KOBE-200).
- **Width.** A dragged width stays in state and the CSS clamps it, so it holds while it fits and
  comes back when the window grows (ac-2). The stored width waits to apply until the window has a
  column to measure (no apply on a phone). It is never saved from a sheet width. A drag at
  820–1100 px is saved (both floors fit there).
- **One-row bar (CE8).** Under 768 px the bar is one row: drawer button (`open-rail`, portalled
  from the workspace through a new `nav` slot), team switcher, title, and a **Menu** (`thread-menu`,
  a `<details>` like the other bar menus). The menu holds row two through the same `context` slot
  (agent picker, model picker, Files), then the search, areas, consoles, bell and profile menu.
  "Title" is the Kobe wordmark; the thread title stays in the conversation header right below.
- **Gauge (CE14).** Not built. ContextRow already carries the B7 slot comment; on one column it
  renders in the menu, and the menu marks the slot.
- **Bar menus.** A press in a Radix popover (a picker's popover, portalled to the body) no longer
  closes the menu. Opening a menu inside another (profile inside Menu) keeps the parent open.
- **Accessibility.** `useModalLayer` (drawer, both sheets): focus moves in, Escape closes the
  drawer, a press outside closes a modal layer, and everything else in the chat is `inert` while
  modal. That is the focus trap, the same as a native modal dialog. Focus returns to the opener.
  The restore runs in a passive effect's cleanup: React restores the pre-commit focus after
  mutations, which undid a restore from a layout effect. The collapsed rail's icons stay mounted
  (`hidden`) so focus can return to the icon that opened the drawer. Drawer and sheet animations
  sit only under `prefers-reduced-motion: no-preference`. No text links added.
- **Commands:** `open-rail` (rail), `thread-menu` (thread), `artifact-back` (artifact). The bar
  registry test still sees exactly the `bar` scope at wide.
- **Tests run at 1280 px.** happy-dom defaults to 1024 px, which is the 820–1100 band. The new
  `apps/web/vitest.config.ts` sets the window to 1280×800. `lib/testing/viewport.ts`
  `resizeWindow()` drives happy-dom's real `matchMedia` and `resize`.
- **Replaced KOBE-205's one-column rows** (`minmax(min(20rem,100%),1fr)` with 40/50dvh caps): under
  768 px the conversation is the only grid row. The drawer and sheet lie over it.

## Open questions (for Chris or the coordinator)

- Diff is ~720 added non-test lines, ~600 net. About 150 are comments and re-indentation, so it
  is at the ~700 guide. Split if wanted: (1) bands, yield order, drawer, overlay sheet;
  (2) the one-row bar and the full-screen sheet.
- The overflow menu stays open after a search hit opens a thread (the drawer closes). Small
  follow-up if it bothers anyone on a phone.

## Evidence (acceptance criteria → test or command output)

No Playwright in the repo (dependency decision pending). Per the coordinator: layout rules are
covered by vitest (pure functions, per-band component tests with happy-dom's `matchMedia`/`resize`,
CSS contract). The **e2e measurement at 1280, 960, 800 and 390 px is done on gate1 by the
coordinator** after deploy.

- **ac-1:** `lib/shell/layout.test.ts` has the four table widths and checks that the
  conversation is ≥ 400 px and the column ≥ 360 px for every width from 768 to 2000 px, every
  dragged width and both rail states. `components/shell/breakpoints.test.tsx` "the CE7 table, per
  band" covers what each of 1280/960/800/390 renders. `components/shell/layout-contract.test.tsx`
  "breakpoints" checks that the media queries sit on `BREAKPOINTS`, the 48 px rail below 1100,
  the floors from 820, the overlay sheet, the single column and reduced motion.
- **ac-2:** `breakpoints.test.tsx` "manual choices come back when space returns": a collapsed rail
  through 960/390/1280; an expanded rail auto-collapsed and back, unsaved; a dragged width through
  800/390 and back at 1280 (one PUT); a drawer closing when the window grows.
  `layout.test.ts` covers the same in arithmetic.
- **ac-3:** `breakpoints.test.tsx` 390 cases: the drawer (dialog, inert background, close and
  focus return), the full-screen sheet (dialog, Back by Escape, tab strip, focus return), and the
  one-row bar with the menu holding the agent picker, the model picker, Files and the search. The
  menu stays open through a picker and the nested profile menu. The gauge slot is marked (B7
  builds it).
- Updated for the new behaviour: `threads.test.tsx`, `shell.test.tsx` (narrow cases now use the
  drawer), `layout-preferences.test.tsx`, `rail-drop-zone.test.tsx` (its `matchMedia` fake answers
  the min-width bands), `preferences.test.ts` (`applyRailCollapsed`).

# KOBE-419: Workspace rail header: team selector, Threads and Files panel toggles, and the Team admin button on the rail's top line

- **Status:** committed on the group branch (not pushed)
- **Branch / worktree:** `group-9-layout` in `../Kobe-g9`
- **Depends on:** KOBE-418 (one-row bar), KOBE-305 (rail width, server prefs), KOBE-198/199/304
  (rail Files, drop zone, tree), KOBE-202 (layout preferences)

## Decisions

- **No migration.** `users.ui_preferences` is a jsonb document validated by the protocol schema,
  so the new key is `rail_panels: "both" | "threads" | "files"` (`RAIL_PANELS`) in
  `packages/protocol/src/ui-preferences.ts`, as KOBE-305 added `rail_width`. There is no `none`,
  so the rail always shows a panel. Server DB test and protocol tests cover it.
- **Top line** (`workspace-rail.tsx` `RailHeader`, `rail.module.css`): the team selector (flex,
  `min-width: 0`, the name ellipsized with its full text as `title`), then a `headerActions` group
  that never shrinks: Threads panel, Files panel, Team console (team admins), collapse. Icons are
  28 px so the line fits at the 200 px minimum. `flex-wrap: nowrap`.
- **Team selector** (`app/team-switcher.tsx` split into `useMyTeams`, `TeamMenu`, `TeamSwitcher`,
  `TeamActivation`; `components/shell/rail-team.tsx`): in the rail, a menu when the member has
  more than one team (roles, active one marked and disabled, switch sets the active team, reloads
  and forgets the last thread), the plain name (h2) with one. The bar's switcher is gone. It also
  activated a team on first load; `TeamActivation` in `ChatApp` keeps that, since the rail renders
  only once a team is active. Its errors show under the line. The consoles keep `TeamSwitcher`.
  The no-team text is now the switcher's ("You are not in any team yet…").
- **Phone:** the drawer's header is the same line, so the selector heads the drawer; the bar
  shows the active team's name beside the drawer button (follow-up below).
- **Toggles** (`rail-threads`, `rail-files` commands, "Threads panel" / "Files panel",
  `aria-pressed`, `aria-controls`): one panel alone fills the rail (rows `minmax(0, 1fr)`) and the
  divider is not rendered; both on restore the divider and the saved share. The last panel on is
  `aria-disabled` with "At least one panel stays on." as tooltip and description. A hidden panel
  stays mounted (`.section[hidden]{display:none}`, so its tree and listing survive). The Files
  toggle's tooltip shows Mod+Shift+F.
- **Saving** (`rail-state.tsx` `useRailPanels`, `lib/shell/rail-panels.ts`): the toggles are saved
  per member (debounced PUT, like `rail_width`). Show threads, Show files, Mod+Shift+F and a drop
  turn the panel on for the page only, not saved, like their expansions. A drop with nothing
  added still shows Files for its notice.
- **Team console** moved: its command is `rail` scope, rendered on the line when the server opens
  the team console (`useOpenConsoles`); the bar's Administration links list Site console only. The
  palette still lists both (by href).

## Follow-up (coordinator answers, 2026-10-18)

- Under 768 px the bar shows the active team's name beside the drawer button (truncated, full
  name as tooltip; `RailDrawerButton`), so the team is visible without opening the drawer
  (`rail-header.test.tsx`). Wide windows show the rail itself and no name in the bar.
- The button keeps the product's name, "Team console".

## Review fixes (review-419, 2026-10-18)

- S1: the team slot clips and is a container; the name keeps a 2.5rem minimum and truncates; the
  role shrinks first and hides under a 7.5rem slot; a caret marks the menu. CSS contract test;
  `rail-resize.spec.ts` checks at 200 px that the name and the buttons don't overlap.
- S2: the collapsed rail leads with the team's initials (name and role as tooltip and name); with
  several teams it opens the team list in a popover. Tests for one and several teams.
- S3: teams but none active yet shows "Choosing your team…" until one is active.
- S4: the phone bar's name is capped at `min(9rem, 30vw)`, so the row doesn't wrap; the phone
  e2e checks the bar stays one row.
- Nits: `.teamMenu .teamList` wins over `.menuList`; one `useMyTeams` read for the rail; comment
  wraps; the drawer's Threads reveal documented; tests for Escape in the drawer's team menu and an
  unknown stored panels value; Team console and the second context are hard e2e assertions.
- Disagreed: none. Not done: the doubled access/teams fetch between the bar and the rail (N4).

## Evidence (acceptance criteria → test or command output)

- ac-1: `rail-header.test.tsx` (order, title tooltip, CSS contract: nowrap, truncation, buttons
  don't shrink); `rail-resize.spec.ts` checks the line at the 200 px minimum on gate1.
- ac-2: `rail-header.test.tsx` (menu in the rail not the bar, roles, active marked/disabled,
  switch PUT + reload + remembered team, one team no menu, the drawer under 768 px);
  `shell.test.tsx` (bar has no Teams nav; one menu open at a time still holds).
- ac-3: `rail-header.test.tsx` (default both, one fills, divider hidden and back, last stays on,
  saved and read back); `rail-panels.test.ts`; protocol and server DB tests.
- ac-4: `rail-header.test.tsx` (Mod+Shift+F turns Files on, focuses, unsaved; collapsed Show
  threads); existing rail-files, rail-drop-zone, file tree tests green.
- ac-5: `rail-header.test.tsx` (team admin vs member), `shell.test.tsx`, `icon-action.test.tsx`.
- ac-6: e2e: new `rail-header.spec.ts` (light/dark/phone screenshots, persistence across contexts);
  `support/chat.ts` turns both panels on in `open()` so the Files/Threads specs (files-tree,
  rail-resize, row-menus, composer-cues, organize) never meet a saved single panel;
  `rail-resize.spec.ts` checks the line at minimum width. theme and consoles specs do not use the
  bar switcher or Team console link, so they need no change. Gate1 specs run after the deploy.
- `pnpm --filter @kobe/web test` 185 files / 1850 tests; `@kobe/server` me-preferences DB test 22
  green; `pnpm verify` before the commit.

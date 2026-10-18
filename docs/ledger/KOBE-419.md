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
- **Phone:** the drawer's header is the same line, so the selector heads the drawer; the bar's
  drawer button opens it (the bar shows no team name of its own).
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

## Open questions (for Chris or the coordinator)

- On a phone the bar shows no team name; the drawer button opens the drawer headed by it (the
  AC's "or opens the drawer"). Want the name on the phone bar too?
- The name says "Team console" (the registry's name), as the bar did; the ticket calls it Team
  admin. Rename?

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

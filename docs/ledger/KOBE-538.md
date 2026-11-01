# KOBE-538: Rail team switcher: the team menu's list is clipped, so a member cannot switch teams

- **Status:** in review (commit on `kobe-538-rail-team-menu`, not pushed)
- **Branch / worktree:** `kobe-538-rail-team-menu` in `../Kobe-wt538`
- **Depends on:** none

## Plan

`RailTeam` (apps/web/components/shell/rail-team.tsx) rendered the `TeamMenu` `<details>` disclosure
inside `.teamSlot`, which clips (`overflow: hidden`, `container-type: inline-size`, KOBE-419 review
S1), so the open list was invisible and not hit-testable. Replace it with a Radix `Popover` whose
trigger is a button styled like the old summary and whose content (in `chatPortalContainer()`)
holds the same `TeamList` the collapsed rail's icon uses.

## Decisions

- Trigger keeps `styles.teamSummary` / `styles.team`, so truncation and the `@container` rule hiding
  the role still apply; `.teamSummary` gains a button reset (padding, border, background, font).
- Still wrapped in `<nav aria-label="Teams">` (e2e and component selectors unchanged).
- `TeamMenu` stays as is for the consoles' `TeamSwitcher`; `.teamMenu .teamList` CSS removed (unused).
- `.teamSlot` untouched.
- shell.test.tsx "keeps at most one of the team switcher and the profile menu open" drove the rail's
  `<details>`; now it clicks the popover trigger (profile closes) and the profile summary (popover closes).
- Keyboard: Radix Popover gives Enter/Space to open, focus into the list, Escape to close with focus
  back on the trigger; Tab walks the team buttons (the active one is disabled, as in the icon's list).

## Open questions (for Chris or the coordinator)

- ac-1 needs the browser run against gate1 (coordinator): `e2e/browser/tests/rail-header.spec.ts`
  "switching teams from the top line (KOBE-538)" switches the owner Team1 -> Skill Registry and back
  (in `finally`), attaching `rail-team-menu-{light,dark}.png`.

## Evidence (acceptance criteria → test or command output)

- ac-1: e2e test above (pending gate1 run); component test "switching sets the active team…"
  now opens the popover and picks Operations (PUT `/v1/me/teams/active`, reload).
- ac-2: rail-header.test.tsx CSS contract and one-line tests unchanged and green.
- ac-3: rail-header.test.tsx "opens the list outside the clipped slot; Escape closes it and refocuses
  the name (KOBE-538)": Enter opens, list is in `document.body` but not in `.teamSlot`, a button per
  team, Escape closes and focus returns to the trigger; drawer Escape test still keeps the drawer.
- Whole @kobe/web suite 2816 tests green; `pnpm typecheck`, `pnpm lint`, `pnpm verify` green;
  `tsc -p e2e/browser` clean.

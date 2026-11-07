# KOBE-558: Icon actions: no browser border on the bell, theme toggle and composer +

- **Status:** in review (PR #465, group with KOBE-559 and KOBE-560)
- **Branch / worktree:** `kobe-558-icon-border` in `../Kobe-wt558`
- **Depends on:** none

## Plan

Chris (2026-11-07) saw a border around the Notifications bell and the theme toggle in the bar
and around the composer's +, but not around the Skills and My agents icons. All are `IconAction`.

## Decisions

- Cause, measured on gate1 with a Playwright probe: the three are `<button>`s showing the user
  agent's default `2px outset` border and `ButtonFace` background; the area icons are `<a>`s.
  The chat scopes only a slice of Tailwind's preflight to its root (chat-global.css), and that
  slice never reset a button's border or face. The chat's own "plain button" rule skips any
  button with a `data-slot` (shadcn's Button, and Radix's tooltip trigger sets
  `data-slot="tooltip-trigger"` on every IconAction), so nothing styled them.
- Fix in the preflight slice, not in IconAction: `button[data-slot]` in the chat gets
  `padding: 0; border: 0; background: transparent` in `@layer base`, so utilities (hover
  background, outline variants) still win. The chat CSS snapshot updated on purpose.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/app/__snapshots__/chat-global.own.css.snap` (the new rule); gate1 probe before
  the fix: bell/theme/plus `border: 2px outset`, skills/agents `0px none`; the coordinator
  re-probes after deploy.
- ac-2: `pnpm verify`; PR CI.

# KOBE-197: A1: Shell: two-row utility bar and three-column grid

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-197-shell-layout` in `../Kobe-wt197`
- **Depends on:** none (started before Gate 4 with the user's approval, overriding CE1)

## Plan

New `apps/web/components/shell/*`: `UtilityBar` (row one: team switcher, wordmark, search slot,
area icon links, role-gated console icon links, bell, profile menu; row two: context slot),
`ShellGrid` (rail · artifact · conversation), `ShellSlot`s (the workspace portals its bar parts so
they keep the assistant-ui runtime context), `ContextRow` (agent picker popover / agent chip, model
picker, Files toggle), `ThreadSearch` (moved from the sidebar), `ProfileMenu`, `ChatReturnLink` +
`lib/shell/last-thread.ts` (CE4).

## Decisions

- Bar parts that need the runtime are portalled into bar slots; the bar itself never remounts on a
  team switch or when the team becomes ready (no duplicate access/bell fetches).
- Agent picker: the existing radios, in a radix Popover behind "Chat with: …" in row two; tests open
  it through `agentChoices()` in `components/chat/testing.tsx`.
- Builder test pane keeps its in-thread model picker (`ThreadView contextInBar` defaults false).
- Files panel sits in the artifact column until A2 moves Files into the rail.
- Last thread is per tab (sessionStorage), forgotten on team switch and sign-out; only a UUID is
  ever turned into a link.
- Column floors (360/400) only at ≥ 1100 px; A5 owns the CE7 yield order.
- Slots left: A2 rail, A4 artifact tabs, A5 breakpoints (`shell-grid.tsx`, `shell.module.css`),
  A7 `IconAction` (`bar-links.tsx`), gauge/Detail/branch indicator (`context-row.tsx`).

## Open questions (for Chris or the coordinator)

- Diff is ~880 added / ~240 removed non-test lines, over the ~600 cap; the coordinator chose one
  PR (one cohesive layout change, much of it moves).

## Evidence (acceptance criteria → test or command output)

- ac-1, ac-2: `apps/web/components/shell/shell.test.tsx` (bar rows, role gating, grid regions,
  return to last thread). Web suite 730/730, typecheck, lint, prettier, site wording green locally.
- ac-3: chat e2e only greps `data-kobe-chat` (kept); not yet run in CI.

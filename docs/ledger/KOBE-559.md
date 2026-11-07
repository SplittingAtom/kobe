# KOBE-559: Rail Apps tab: only the chosen picker, no list of MCP apps under it

- **Status:** in review (PR #465, group with KOBE-558 and KOBE-560)
- **Branch / worktree:** `kobe-558-icon-border` in `../Kobe-wt558`
- **Depends on:** none

## Plan

Chris (2026-11-07): "on the left rail when in Apps view, remove the list of MCP apps from the
bottom. I only want to see the picker that is selected."

## Decisions

- `rail-apps.tsx` renders the Pickers section and, when any app lacks only the member's key,
  the "Add your key" hints; the launch list, `useAppLaunch` and the `.appRow` styles are gone.
  Apps with chat or artifact placement are launched from the composer's + menu (KOBE-451), which
  inserts the same card; the rail-launch unit tests that duplicated the + menu's (KOBE-455,
  KOBE-458: `plus-menu.test.tsx`) were removed, the artifact-placement one moved to the + menu.
- Browser specs `app-placement`, `app-item-chips` and `gate-apps/explorer` launch through
  `support/plus-apps.ts` (`launchFromPlusMenu`); `gate-apps/picker` asserts the list is gone
  (the first CI run's gate-apps job caught both).
- Spec MA3 amended 2026-11-07 (docs/specs/mcp-apps-host.md).

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- ac-1: `rail-pickers.test.tsx` ("no app list under it"), `app-cards.test.tsx` (hints stay),
  `app-placement.test.tsx` (+ menu launch).
- ac-2: `pnpm verify`; PR CI; the coordinator runs `app-placement` and `app-item-chips` on gate1.
